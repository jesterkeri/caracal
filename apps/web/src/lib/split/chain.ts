// Reading a split contract from the network: its pots and its settings.
// Read-only calls are simulated, never submitted, so they cost nothing and need
// no signature. A failed read is an error, never zero.

import { Account, BASE_FEE, Networks, Operation, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { NETWORK } from "../stellar/config";
import { splitAddressFor } from "../stellar/split-address";
import { walletStatus, type LedgerReader, type WalletStatus } from "../stellar/wallet-lookup";
import { splitCall } from "./calls";
import { splitErrorText } from "./errors";

/** The part of a stellar-sdk rpc.Server used to read. */
export type SimulatingRpc = { simulateTransaction(tx: ReturnType<TransactionBuilder["build"]>): Promise<rpc.Api.SimulateTransactionResponse> };

export const READ_TIMEOUT_MS = 15_000;

/** A source that exists only for simulation: reads never submit, so it needs no funds and no sequence. */
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export type Pots = { tax: bigint; goal: bigint; spend: bigint };
export type SplitConfig = { owner: string; token: string; taxBps: number; goalBps: number };

async function simulateRead(server: SimulatingRpc, split: string, fn: string, passphrase: string): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(READ_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.invokeHostFunction({ func: splitCall(split, fn, []), auth: [] }))
    .setTimeout(30)
    .build();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sim: rpc.Api.SimulateTransactionResponse;
  try {
    sim = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the Stellar network did not answer within ${READ_TIMEOUT_MS / 1000} seconds`)), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (rpc.Api.isSimulationError(sim)) throw new Error(splitErrorText(sim.error, split));
  const retval = "result" in sim ? sim.result?.retval : undefined;
  if (!retval) throw new Error(`${fn}() returned no answer`);
  return scValToNative(retval);
}

const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  throw new Error("the split contract answered with something other than an amount");
};

/** balances(): the three pots, in stroops of USDC. */
export async function readPots(server: SimulatingRpc, split: string, passphrase: string = NETWORK.passphrase): Promise<Pots> {
  const v = await simulateRead(server, split, "balances", passphrase);
  if (!Array.isArray(v) || v.length !== 3) throw new Error("the split contract's balances() answer was not three amounts");
  return { tax: big(v[0]), goal: big(v[1]), spend: big(v[2]) };
}

/** config(): owner, token and the current split. */
export async function readConfig(server: SimulatingRpc, split: string, passphrase: string = NETWORK.passphrase): Promise<SplitConfig> {
  const v = await simulateRead(server, split, "config", passphrase);
  if (!Array.isArray(v) || v.length !== 4 || typeof v[0] !== "string" || typeof v[1] !== "string" || typeof v[2] !== "number" || typeof v[3] !== "number") {
    throw new Error("the split contract's config() answer was not (owner, token, tax, goal)");
  }
  return { owner: v[0], token: v[1], taxBps: v[2], goalBps: v[3] };
}

/** Whether this wallet's split contract exists on chain (it is always at splitAddressFor(wallet)). */
export async function splitStatus(server: LedgerReader | undefined, wallet: string, passphrase: string = Networks.TESTNET): Promise<{ split: string; status: WalletStatus }> {
  const split = splitAddressFor(wallet, passphrase);
  return { split, status: await walletStatus(server, split) };
}
