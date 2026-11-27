// Adversary c17: when the wallet's USDC balance entry (or the wallet's own data) has expired on the
// network, the page tells the person "The USDC payment was not sent. Nothing left your wallet. Try again."
// A retry can never work (nothing in Caracal restores archived data), and the real cause is never named.
//
// Spec: docs/decisions.md 2026-11-26 row "The relay tells a missing contract apart from a wrong one": "An
// entry past its live-until ledger keeps its wasm and goes on to the simulation, which asks for the restore
// (409). The relay does not pay for restores yet"; src/app/wallet/page.tsx names the same state to the person
// ("its data has expired and must be restored before it can be used ... Caracal cannot restore it yet").
// Attacker goals 4 (a wrong cause) and 5 (no way forward: a "Try again" that cannot work).
// Cause: src/lib/anchor/transfer.ts buildAnchorTransfer() checks only rpc.Api.isSimulationError(sim); a
// restore answer (`restorePreamble`) is not an error, so the assembled transaction is returned. The kit's
// signAndSubmit then reads transaction.simulationData, which throws AssembledTransaction.Errors.ExpiredState
// before anything is submitted, the kit wraps it as code 5002, and src/lib/anchor/flow.ts sendToAnchor()
// shows the generic "not sent ... Try again" text.
//
// Real: stellar-sdk's rpc.Server and AssembledTransaction (against a 127.0.0.1 server that answers
// simulateTransaction with a restore answer, built with the SDK's own SorobanDataBuilder), the page's own
// paymentFor and buildAnchorTransfer, smart-account-kit 0.10.0's real signAndSubmit and sendToAnchor.
// Faked: the passkey, the kit's chain reads, and the relay (a fetch stub that counts its calls).
// The restore answer is constructed, not captured: no live archived wallet exists to record one from.
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Networks, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnchorTransfer, paymentFor } from "../src/lib/anchor/transfer";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";

const TWO = BigInt(20_000_000);
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));

let server: http.Server;
let url: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      const data = new SorobanDataBuilder().build().toXDR("base64");
      // The shape stellar-rpc uses when a simulation needs expired entries restored first.
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { latestLedger: 123, minResourceFee: "1000", transactionData: data, results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }], restorePreamble: { minResourceFee: "1000", transactionData: data } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  vi.restoreAllMocks(); // test/setup-relay-server.ts stubs rpc.Server methods; this test needs the real SDK
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pay() {
  const server = new rpc.Server(url, { allowHttp: true });
  const built = await buildAnchorTransfer(WALLET, paymentFor(waiting, TWO), server); // real socket, before fetch is stubbed
  const relayCalls: string[] = [];
  vi.stubGlobal("fetch", async (u: string) => {
    relayCalls.push(String(u));
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
  k.rpc = { simulateTransaction: async () => ({ error: "not reached" }), pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) };
  const deps: SendDeps = { buildTransfer: async () => built, signAndSubmit: (t) => kit.signAndSubmit(t as never) };
  return { relayCalls, built, result: await sendToAnchor(waiting, TWO, deps) };
}

describe("adversary c17: the wallet's data has expired on the network (the simulation asks for a restore)", () => {
  it("control: the real build sees a restore answer, nothing reaches the relay, and the send ends 'not sent'", async () => {
    const { relayCalls, built, result } = await pay();
    expect(rpc.Api.isSimulationRestore((built as unknown as { simulation: rpc.Api.SimulateTransactionResponse }).simulation)).toBe(true);
    expect(relayCalls).toEqual([]);
    expect(result.kind).toBe("not-sent");
  });

  it("names the expired data, and does not promise that trying again helps", async () => {
    const { result } = await pay();
    const message = "message" in result ? result.message : "";
    // today: "The USDC payment was not sent. Nothing left your wallet. Try again."
    expect(message).toMatch(/expired|restor|archiv/i);
    expect(message).not.toMatch(/Try again\.?$/);
  });
});
