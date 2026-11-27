// Adversary c5: a failure of the kit's RE-SIMULATION (a contract error such as the WebAuthn verifier's
// "ChallengeInvalid", Error(Contract, #3114)) happens before anything is submitted, yet the page says
// the USDC "may still go through ... Do not send it again", keeps the send lock and offers no way forward.
//
// Spec: docs/decisions.md 2026-11-27 "Cash-out fixes (1)": a send is "not sent" on proof, "a kit failure
// before it submits anything"; and goals 4 (told something false) and 5 (no way forward). The kit's own
// stage tells the truth: node_modules/smart-account-kit/dist/kit/tx-ops.js signAndSubmit() throws from
// resimulateAndAssemble() (decodeContractError -> ContractError, code 10000, before sendAndPoll is called)
// and returns it as { success:false, error } with no hash.
// Cause: src/lib/anchor/flow.ts provenNotSent() accepts only kit codes 4001 to 4004, 5001, 5002 (BEFORE_SUBMIT),
// so code 10000 falls through to "unknown".
//
// Real: smart-account-kit 0.10.0's real signAndSubmit, signResimulateAndPrepare, resimulateAndAssemble and
// relayer client; the page's own paymentFor and transferHostFunction (the muxed destination). Faked: the passkey
// signature (kit.signAuthEntryInternal returns the entry), the context rule lookup, and the RPC's answer. The
// relay is a fetch stub that counts the calls, so "nothing was submitted" is observed, not assumed.
import { readFileSync } from "node:fs";
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";

const TWO = BigInt(20_000_000);
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The transfer as the page builds it, as an assembled transaction the kit can sign (as in adversary-c4-onchain-failed.test.ts). */
function assembled() {
  const call = transferHostFunction(WALLET, paymentFor(waiting, TWO));
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call.invokeContract()), subInvocations: [] }),
  });
  const built = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeHostFunction({ func: call, auth: [entry] }))
    .setTimeout(30)
    .build();
  return { built, simulationData: { result: { auth: [entry] } } };
}

/** A real kit whose passkey and rule lookup are faked and whose RPC answers the re-simulation as `resim` says. */
function pay(resim: () => Promise<unknown>) {
  const relayCalls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    relayCalls.push(String(url));
    return new Response(JSON.stringify({ success: true, data: { transactionId: "tx-1", hash: "ab".repeat(32), status: "confirmed" } }), { status: 200 });
  });
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://relay.test/api/relay",
    storage: new MemoryStorage(),
    rpName: "Caracal",
  });
  const k = kit as unknown as Record<string, unknown>;
  k._contractId = WALLET;
  k.signAuthEntryInternal = async (e: unknown) => e; // the passkey signature is not under test
  k.resolveConnectedContextRuleIds = async () => [0];
  k.rpc = { simulateTransaction: resim, pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) };
  const tx = assembled();
  const deps: SendDeps = { buildTransfer: async () => tx, signAndSubmit: (t) => kit.signAndSubmit(t as never) };
  return { relayCalls, result: sendToAnchor(waiting, TWO, deps) };
}

describe("adversary c5: the kit's re-simulation fails with a contract error, before anything is submitted", () => {
  it("control: a re-simulation that fails with a plain network error is not sent (code 5002), and the relay was never called", async () => {
    const { relayCalls, result } = pay(async () => {
      throw new Error("fetch failed");
    });
    expect((await result).kind).toBe("not-sent");
    expect(relayCalls).toEqual([]);
  });

  it("a re-simulation rejected by the WebAuthn verifier (Error(Contract, #3114)) submitted nothing, so it is not 'may still go through'", async () => {
    const { relayCalls, result } = pay(async () => ({ error: "HostError: Error(Contract, #3114)\n\nEvent log (newest first): ..." }));
    const r = await result;
    expect(relayCalls).toEqual([]); // the harness works: the relay was never reached, nothing was submitted
    expect(r.kind).toBe("not-sent"); // today: "unknown", with "It may still go through ... Do not send it again."
  });
});
