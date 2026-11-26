// Builds the sponsored transaction on the server, so what runs on chain is
// exactly what was checked here.
//
// The policy (policy.ts) decides which calls Caracal sponsors. This step then
// proves it against the chain:
// 1. The relay's own testnet account is the transaction source, so the
//    relayer's account is never an implicit signer.
// 2. The exact call is simulated with every signature enforced, so junk or
//    forged auth entries are refused here instead of reaching the relayer.
// 3. Every wasm that would run is read from the simulated footprint and must be
//    Caracal's own (passkey wallet, split contract, WebAuthn verifier). A wallet
//    upgraded to other code is refused, whatever any cache says.
// 4. The transaction is assembled with that footprint and signed. Soroban only
//    runs code whose ledger entries are in the footprint, so if a wallet is
//    upgraded after this check, the new code is not in the footprint and the
//    transaction fails instead of running it.
// The upstream relayer only wraps the signed transaction in a fee bump.

import { Account, Keypair, Operation, TransactionBuilder, rpc, xdr, type Transaction } from "@stellar/stellar-sdk";

/** Seconds the transaction stays valid. Channels refuses time bounds far in the future. */
export const TX_TIMEOUT_S = 25;

export type SponsorDeps = {
  source: Keypair;
  networkPassphrase: string;
  /** Current sequence for the source account (from RPC). */
  loadAccount: (publicKey: string) => Promise<Account>;
  /** simulateTransaction with authMode "enforce". */
  simulate: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>;
  /** Hex sha256 of every wasm Caracal lets run in a sponsored transaction. */
  allowedCode: ReadonlySet<string>;
  /** Most resource fee, in stroops, Caracal sponsors for one transaction. */
  maxResourceFee: bigint;
};

export type Sponsored = { ok: true; xdr: string } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): Sponsored => ({ ok: false, status, error });

/** Every wasm hash a transaction's footprint would load. */
export function footprintCode(data: xdr.SorobanTransactionData): string[] {
  const fp = data.resources().footprint();
  return [...fp.readOnly(), ...fp.readWrite()]
    .filter((k) => k.switch().name === "contractCode")
    .map((k) => k.contractCode().hash().toString("hex"));
}

export async function buildSponsoredTx(body: { func: string; auth: string[] }, deps: SponsorDeps): Promise<Sponsored> {
  const func = xdr.HostFunction.fromXDR(body.func, "base64");
  const auth = body.auth.map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"));

  const account = await deps.loadAccount(deps.source.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: deps.networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(TX_TIMEOUT_S)
    .build();

  const sim = await deps.simulate(tx);
  if (rpc.Api.isSimulationError(sim)) {
    console.error("relay simulation refused:", sim.error.slice(0, 300));
    return refuse(400, "The network refused this call in simulation (a signature or contract check failed).");
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    return refuse(409, "Part of this contract's data has expired on the network and must be restored first.");
  }

  const data = sim.transactionData.build();
  const foreign = footprintCode(data).filter((h) => !deps.allowedCode.has(h));
  if (foreign.length > 0) {
    console.error("relay refused foreign code:", foreign.join(","));
    return refuse(403, "This call would run code that is not Caracal's.");
  }
  if (BigInt(sim.minResourceFee) > deps.maxResourceFee) {
    return refuse(403, "This call needs more network resources than Caracal sponsors.");
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  // The auth entries must be the ones the policy checked and the simulation
  // verified, not ones the simulation filled in.
  const op = assembled.operations[0] as Operation.InvokeHostFunction;
  const sent = (op.auth ?? []).map((a) => a.toXDR("base64"));
  if (sent.length !== body.auth.length || sent.some((a, i) => a !== body.auth[i])) {
    return refuse(400, "The auth entries changed during simulation.");
  }
  assembled.sign(deps.source);
  return { ok: true, xdr: assembled.toXDR() };
}

/** Runs one task at a time, so two transactions never use the same sequence number. */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
