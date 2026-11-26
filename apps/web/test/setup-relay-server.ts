// The relay server's own configuration, as every test sees it: a fresh random
// testnet keypair as the relay's source account (generated here, never a real
// secret), a test Channels key, and the chain's answers for that account and
// for simulation. OpenZeppelin Channels is a local fake HTTP server, so tests
// never reach the network but the official client's real code runs. The simulated footprint is the one a passkey wallet's USDC
// transfer really loads: the account wasm and the WebAuthn verifier wasm (USDC
// is a built-in asset contract with no wasm). Tests that need other chain
// answers override these spies.
import { Account, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";

export const codeKey = (hash: string) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, "hex") }));

/** A successful simulation whose footprint loads exactly these wasm hashes. */
export function simulated(code: string[], minResourceFee = "120000"): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: "sim",
    latestLedger: 1_000_000,
    events: [],
    minResourceFee,
    transactionData: new SorobanDataBuilder().setReadOnly(code.map(codeKey)).setResourceFee(minResourceFee),
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  } as rpc.Api.SimulateTransactionSuccessResponse;
}

type Reply = (req: IncomingMessage, res: ServerResponse) => void;
const confirmed: Reply = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data: { transactionId: "tx-1", hash: "ab".repeat(32), status: "confirmed" }, error: null }));
};
/** The fake Channels service: set `reply` to choose its answer; `requests` holds what it received. */
export const fakeChannels = {
  url: "",
  reply: confirmed as Reply,
  requests: [] as { authorization?: string; path?: string; body: unknown }[],
};
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {}
    fakeChannels.requests.push({ authorization: req.headers.authorization, path: req.url, body });
    fakeChannels.reply(req, res);
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fakeChannels.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  fakeChannels.reply = confirmed;
  fakeChannels.requests = [];
  vi.stubEnv("RELAY_SOURCE_SECRET", Keypair.random().secret());
  vi.stubEnv("CHANNELS_API_KEY", "test-channels-key");
  vi.stubEnv("CHANNELS_BASE_URL", fakeChannels.url);
  vi.stubEnv("CHANNELS_TIMEOUT_MS", "2000");
  vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => new Account(id, "1000"));
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () =>
    simulated([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]),
  );
});
