// Adversary c3: the relay has CONFIRMED the USDC payment, then the kit waits for the RPC with no
// deadline, and the page stays on "Waiting for your passkey..." for ever.
//
// Spec: docs/decisions.md 2026-11-27 "Cash-out: the Stellar RPC calls on its path ... have the same
// 20 s limit as anchor requests" and the page's own promise that every wait ends in a shown result
// (goal 5: no page that hangs without bound, no way forward). The page bounds the RPC calls it makes
// itself (latest ledger, the transfer simulation, the balance read) but calls
// kit.signAndSubmit (src/app/cashout/page.tsx send(), no deadline). smart-account-kit 0.10.0
// sendAndPoll (dist/kit/tx-ops.js) awaits rpc.pollTransaction after the relayer answered; stellar-sdk's
// rpc.Server has no timeout. A passkey prompt is over by then: the button label is a false state,
// the payment has landed, the sending lock is held, and "Start another cash-out" is withheld
// while phase is "sending".
//
// Real: the page, src/lib/anchor/*, smart-account-kit's real signAndSubmit, relayer client and
// sendAndPoll, stellar-sdk's real rpc.Server against a 127.0.0.1 server that accepts and never
// answers. Faked: the anchor (the repo's captured fixtures), the passkey step (as in
// adversary-c1-relay-unknown-outcome.test.ts), the relay (a local server that answers "confirmed").
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET as FIXTURE_WALLET } from "./relay-fixtures";
import { buttonLabels, clickButton, fixture, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const HASH = "ab".repeat(32);
const realSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
let hangServer: http.Server;
let relayServer: http.Server;
let hangUrl: string;
let relayUrl: string;
let polls = 0;
beforeAll(async () => {
  hangServer = http.createServer(() => {
    polls++; // accepts the request, never answers
  });
  relayServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { transactionId: "tx-1", hash: HASH, status: "confirmed" } }));
    });
  });
  await Promise.all([hangServer, relayServer].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  hangUrl = `http://127.0.0.1:${(hangServer.address() as AddressInfo).port}`;
  relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  hangServer.closeAllConnections();
  await Promise.all([hangServer, relayServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
});
beforeEach(() => {
  polls = 0;
  vi.restoreAllMocks(); // test/setup-relay-server.ts stubs rpc.Server methods for every test; this one needs the real SDK
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); // sockets run in real time
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** The real kit's signAndSubmit with only the passkey step replaced; `pollRpc` is what it polls for confirmation. */
function realSubmit(pollRpc: unknown) {
  const waiting = parseTransaction(JSON.parse(fixture("txn-pending-user-transfer-start.json")));
  const call = transferHostFunction(FIXTURE_WALLET, paymentFor(waiting, BigInt(20_000_000)));
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(FIXTURE_WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
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
  (kit as unknown as { _contractId: string })._contractId = FIXTURE_WALLET;
  (kit as unknown as { signResimulateAndPrepare: unknown }).signResimulateAndPrepare = async () => built;
  (kit as unknown as { rpc: unknown }).rpc = pollRpc;
  return () => kit.signAndSubmit({ built, simulationData: { result: { auth: [entry] } } } as never);
}

describe("adversary c3: the relay confirmed the payment but the RPC never answers the kit's confirmation poll", () => {
  it("control: with an answering RPC the real kit reports the payment and the page leaves 'Waiting for your passkey...'", async () => {
    const { rt, world } = await mount({ submit: realSubmit({ pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) }) });
    await toConfirm(rt, world);
    expect(buttonLabels(rt.tree)).toContain("Send 2 USDC to the anchor");
    void clickButton(rt.tree, /Send 2 USDC/);
    await realSleep(300); // real time: the relay answers over a real socket
    await tick(50);
    expect(text(rt)).toContain(HASH);
    expect(buttonLabels(rt.tree)).not.toContain("Waiting for your passkey...");
    rt.unmount();
  });

  it("control: the real stellar-sdk rpc.Server pointed at this server really does hang", async () => {
    const s = new rpc.Server(hangUrl, { allowHttp: true });
    vi.useRealTimers();
    const outcome = await Promise.race([s.getTransaction(HASH).then(() => "answered", () => "rejected"), new Promise<string>((r) => setTimeout(() => r("hangs"), 1000))]);
    expect(outcome).toBe("hangs");
    expect(polls).toBeGreaterThan(0);
  });

  it("send: a confirmation poll that never answers does not leave the page on 'Waiting for your passkey...' for ever", async () => {
    const hanging = new rpc.Server(hangUrl, { allowHttp: true });
    const { rt, world } = await mount({ submit: realSubmit(hanging) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await realSleep(400); // real time: the relay confirms and the kit's poll reaches the RPC
    await tick(10 * 60_000); // then ten minutes of the page's own time
    expect(polls).toBeGreaterThan(0); // the kit really is waiting on the RPC
    expect(buttonLabels(rt.tree)).not.toContain("Waiting for your passkey...");
    rt.unmount();
  });
});
