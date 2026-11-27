// Adversary c4: a USDC payment that the chain REJECTED (the relay's own words: "This transaction
// failed on the network (ONCHAIN_FAILED), so nothing changed.") is shown as "It may still go
// through ... Do not send it again", and the person is left with no control at all.
//
// Spec: src/lib/relay/channels.ts says ONCHAIN_FAILED "reached the ledger and failed, so it changed
// nothing" and answers "so nothing changed" (test/relay-channels.test.ts pins that text).
// docs/decisions.md 2026-11-27 "Cash-out fixes (1)" lets the page call a send "not sent" on proof
// that nothing left; and goals 4 and 5: a person is not told something false ("may still go
// through" when the chain says nothing changed) and is not left without a way forward.
// Cause: src/lib/anchor/flow.ts provenNotSent() accepts only the text "Nothing was sent" or kit
// codes 4001 to 4004, 5001, 5002; the relay's ONCHAIN_FAILED answer (kit code 5003, no hash) is
// neither, so sendToAnchor returns "unknown", src/app/cashout/page.tsx send() keeps the once-only
// lock and moves to "watching", where no Send and no Start again is offered while the anchor still
// says "waiting for your USDC" (a failed on-chain payment is plausible: the anchor's account may
// lack a USDC trustline, or the balance moved between the preview and the send).
//
// Real: the page's own transfer (paymentFor, transferHostFunction), smart-account-kit 0.10.0's real
// signAndSubmit and relayer client, the REAL /api/relay route (policy, simulation, the official
// Channels client). Faked: the passkey step (as in adversary-c3-relay-call-refusal.test.ts), the
// chain's answers, and Channels (the local fake from setup-relay-server.ts).
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";
import { buttons, buttonLabels, clickButton, mount, text, tick, toConfirm, unmock, WALLET as PAGE_WALLET } from "./adversary-c2-harness";

const realSetTimeout = setTimeout;
const TWO = BigInt(20_000_000);
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));
const ONCHAIN_FAILED = (req: http.IncomingMessage, res: http.ServerResponse) => {
  req.resume();
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, error: "x", data: { code: "ONCHAIN_FAILED" } })); // the shape relay-channels.test.ts pins
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  (kit as unknown as { signResimulateAndPrepare: unknown }).signResimulateAndPrepare = async () => tx.built;
  (kit as unknown as { rpc: unknown }).rpc = { pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) };
  const deps: SendDeps = { buildTransfer: async () => tx, signAndSubmit: (t) => kit.signAndSubmit(t as never) };
  return sendToAnchor(waiting, TWO, deps);
}

describe("adversary c4: a payment the chain rejected (ONCHAIN_FAILED)", () => {
  it("control: with a healthy chain the real kit and real relay route send the payment", async () => {
    walletOnChain();
    const r = await pay();
    expect(fakeChannels.requests.length).toBe(1);
    expect(r).toEqual({ kind: "sent", hash: "ab".repeat(32) });
  });

  it("the relay says 'failed on the network, so nothing changed': the page must not say it may still go through", async () => {
    walletOnChain();
    fakeChannels.reply = ONCHAIN_FAILED;
    const r = await pay();
    expect(fakeChannels.requests.length).toBe(1); // it reached Channels and failed on the ledger
    expect(r.kind).toBe("not-sent");
  });
});

// ---- the page: what the person is left with --------------------------------------------------------
describe("adversary c4: the page after the chain rejected the payment", () => {
  let relay: http.Server;
  let relayUrl: string;
  let mode: "ok" | "failed" = "ok";
  beforeAll(async () => {
    relay = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (mode === "failed") {
          // exactly the answer the real route gives for a Channels ONCHAIN_FAILED (relay-channels.test.ts line 164)
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "This transaction failed on the network (ONCHAIN_FAILED), so nothing changed." }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, data: { transactionId: "tx-1", hash: "ab".repeat(32), status: "confirmed" } }));
        }
      });
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => relay.close(() => r())));

  const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

  function realSubmit() {
    const call = transferHostFunction(PAGE_WALLET, paymentFor(waiting, TWO));
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(PAGE_WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call.invokeContract()), subInvocations: [] }),
    });
    const built = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.invokeHostFunction({ func: call, auth: [entry] }))
      .setTimeout(30)
      .build();
    const kit = new SmartAccountKit({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
      accountWasmHash: SMART_ACCOUNT.accountWasmHash,
      webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
      relayerUrl: relayUrl,
      storage: new MemoryStorage(),
      rpName: "Caracal",
    });
    (kit as unknown as { _contractId: string })._contractId = PAGE_WALLET;
    (kit as unknown as { signResimulateAndPrepare: unknown }).signResimulateAndPrepare = async () => built;
    (kit as unknown as { rpc: unknown }).rpc = { pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) };
    return () => kit.signAndSubmit({ built, simulationData: { result: { auth: [entry] } } } as never);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); // the relay socket runs in real time
  });
  afterEach(() => {
    unmock();
  });

  it("control: a confirmed payment shows its hash", async () => {
    mode = "ok";
    const { rt, world } = await mount({ submit: realSubmit() });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await realSleep(300);
    await tick(50);
    expect(text(rt)).toContain("ab".repeat(32));
    rt.unmount();
  });

  it("the chain rejected it: the page offers a way forward and does not say it may still go through", async () => {
    mode = "failed";
    const { rt, world } = await mount({ submit: realSubmit() });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await realSleep(300);
    await tick(50);
    // The relay really answered, through the real kit.
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    await tick(10_000); // the anchor still says "waiting for your USDC"; nothing the person can press
    const enabled = buttons(rt.tree).filter((b) => !b.props?.disabled);
    expect({ says: /may still go through/.test(text(rt)), offered: enabled.map((b) => buttonLabels([b])[0]) }).toEqual({ says: false, offered: expect.arrayContaining([expect.stringMatching(/Send|Start/)]) });
    rt.unmount();
  });
});
