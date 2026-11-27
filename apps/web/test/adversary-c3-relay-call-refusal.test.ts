// Adversary c3: a USDC payment the relay refused BEFORE sending anything is shown as
// "may still go through. Do not send it again", and the page's once-only send lock stays.
//
// Spec: docs/decisions.md 2026-11-27 "Cash-out fixes (1)": "A USDC send is 'not sent' (lock
// released, 'Nothing left your wallet') only with proof: the relay's own refusal text 'Nothing
// was sent'" and, in the Changed-test note, "a real relay refusal before sending carries that
// text". docs/decisions.md 2026-11-26 (row on "Every relay refusal made before anything is sent
// upstream says 'Nothing was sent'") promises the same of the relay.
// Cause: src/app/api/relay/route.ts answers a refusal of a CALL with `fail(...)`, not `refuse(...)`
// (the policy's refusals at the `!verdict.ok` branch, and the simulation's at `!built.ok`), so
// "Nothing was sent" is added for wallet deployments only. src/lib/anchor/flow.ts sendToAnchor
// (provenNotSent) then finds no proof and returns "unknown": the person is told "It may still go
// through ... Do not send it again", the page holds the lock, and Send cannot be pressed again for
// this withdrawal (goals 4 and 5: a false "may still go through", and no way forward).
//
// Real: the page's own transfer (paymentFor, transferHostFunction), smart-account-kit 0.10.0's
// real signAndSubmit and relayer client, the REAL /api/relay route (policy, simulation, Channels
// client). Faked: the passkey step (as in adversary-c1-relay-unknown-outcome.test.ts), the chain's
// answers (a ledger lookup that fails, a simulation that refuses) and Channels (the local fake from
// setup-relay-server.ts, which records what it received: nothing, in every refusal below).
import { readFileSync } from "node:fs";
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

beforeEach(() => {
  vi.resetModules(); // a fresh relay route: its wallet lookup cache starts empty
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TWO = BigInt(20_000_000);
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));

function walletOnChain() {
  const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null });
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(WALLET).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(inst),
  });
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [{ val: xdr.LedgerEntryData.contractData(data) }] })) as never);
}

/** The real kit, wired to the real relay route in-process; only the passkey step is replaced. */
async function realKit() {
  const { POST } = await import("../src/app/api/relay/route");
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => POST(new Request("http://x/api/relay", init)));
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://x/api/relay",
    storage: new MemoryStorage(),
    rpName: "Caracal",
  });
  (kit as unknown as { _contractId: string })._contractId = WALLET;
  return kit;
}

/** What the page hands signAndSubmit, built from the page's own code (paymentFor, transferHostFunction). */
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

async function pay() {
  const kit = await realKit();
  const tx = assembled();
  // The passkey step only: sign nothing, hand the same host function and entry on.
  (kit as unknown as { signResimulateAndPrepare: unknown }).signResimulateAndPrepare = async () => tx.built;
  (kit as unknown as { rpc: unknown }).rpc = { pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) };
  const deps: SendDeps = { buildTransfer: async () => tx, signAndSubmit: (t) => kit.signAndSubmit(t as never) };
  return sendToAnchor(waiting, TWO, deps);
}

describe("adversary c3: a USDC payment the relay refused before sending anything", () => {
  it("control: with a healthy chain the real kit and real relay route send the payment", async () => {
    walletOnChain();
    const r = await pay();
    expect(fakeChannels.requests.length).toBe(1);
    expect(r).toEqual({ kind: "sent", hash: "ab".repeat(32) });
  });

  it("control: a relay whose Channels connection drops AFTER it received the transaction is rightly unknown", async () => {
    walletOnChain();
    fakeChannels.reply = (req) => req.socket.destroy();
    const r = await pay();
    expect(fakeChannels.requests.length).toBe(1);
    expect(r.kind).toBe("unknown");
  });

  it("the relay's ledger lookup of the wallet failed (503, nothing sent): the page must not say it may still go through", async () => {
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockRejectedValue(new Error("rpc unavailable"));
    const r = await pay();
    expect(fakeChannels.requests.length).toBe(0); // proof: nothing reached Channels
    expect(r.kind).toBe("not-sent");
  });

  it("the relay's simulation refused the call (400, nothing sent): the page must not say it may still go through", async () => {
    walletOnChain();
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({ id: "sim", latestLedger: 1_000_000, error: "HostError: Error(Auth, InvalidAction)" } as never);
    const r = await pay();
    expect(fakeChannels.requests.length).toBe(0); // proof: nothing reached Channels
    expect(r.kind).toBe("not-sent");
  });
});
