// Payments (every sponsored call except creating a wallet) go to OpenZeppelin
// Channels through its official client (Joshua's decision on Codex r3 #1).
// The client's real code runs here against a local stand-in for Channels, so
// these tests cover what Caracal does with each kind of answer.
//
// Changed expectation (recorded in docs/decisions.md): the r2d test "an
// upstream 204 is passed on" still holds for wallet creation, which goes to
// the SDF proxy. On the payment path an empty answer carries no transaction
// hash, so nobody could tell whether the payment happened; Caracal answers a
// controlled 502 that says so instead of passing on the empty 204.
import { Address, Networks, TransactionBuilder, rpc, xdr, type Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelsClient, submitToChannels } from "../src/lib/relay/channels";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, transferArgs } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const call = () =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
const transfer = () => ({
  func: xdr.HostFunction.hostFunctionTypeInvokeContract(call()).toXDR("base64"),
  auth: [
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call()), subInvocations: [] }),
    }).toXDR("base64"),
  ],
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

async function pay() {
  walletOnChain();
  const proxy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", proxy);
  const { POST } = await import("../src/app/api/relay/route");
  const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
  expect(proxy).not.toHaveBeenCalled(); // payments never use the proxy
  return { r, body: (await r.json()) as { success: boolean; data?: unknown; error?: string } };
}

const answer = (status: number, body: string, type = "application/json") =>
  (fakeChannels.reply = (_req, res) => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  });

describe("the official Channels client submits exactly the transaction the relay signed", () => {
  it("submitToChannels sends the same signed XDR, byte for byte, with the API key", async () => {
    const xdrIn = "AAAAAgAAAAB-the-exact-string-the-relay-signed==";
    const out = await submitToChannels(channelsClient("k-1", fakeChannels.url, 2000), xdrIn);
    expect(out).toEqual({ ok: true, data: { transactionId: "tx-1", hash: "ab".repeat(32), status: "confirmed" } });
    expect(fakeChannels.requests).toHaveLength(1);
    expect(fakeChannels.requests[0]).toMatchObject({ authorization: "Bearer k-1", path: "/", body: { params: { xdr: xdrIn } } });
  });

  it("through the route: a payment reaches Channels as the relay's signed transaction and the wallet kit gets { success, data }", async () => {
    const { r, body } = await pay();
    expect(r.status).toBe(200);
    expect(body).toEqual({ success: true, data: { transactionId: "tx-1", hash: "ab".repeat(32), status: "confirmed" } });
    const sent = TransactionBuilder.fromXDR((fakeChannels.requests[0]!.body as { params: { xdr: string } }).params.xdr, Networks.TESTNET) as Transaction;
    expect(sent.signatures).toHaveLength(1);
    expect((sent.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] }).auth!.map((a) => a.toXDR("base64"))).toEqual(transfer().auth);
  });
});

describe("every Channels answer without a transaction hash becomes a controlled, useful error", () => {
  // Without a hash the payment may or may not have happened, so the user is told to check first.
  const controlled = (body: { success: boolean; error?: string }) => {
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/^The fee relayer .*\. Check your activity before trying again\.$/);
  };

  it("an empty 204 answer: 502, not a pass-through, and the user is told to check before retrying", async () => {
    answer(204, "");
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    controlled(body);
  });

  it("an empty 200 answer: 502", async () => {
    answer(200, "");
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    controlled(body);
  });

  it("success without a hash: 502 that says to check activity", async () => {
    answer(200, JSON.stringify({ success: true, data: { status: "pending" }, error: null }));
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    expect(body.error).toMatch(/Check your activity/);
  });

  it("an HTML error page: 502, and no HTML reaches the user", async () => {
    answer(500, "<html><body>Bad gateway</body></html>", "text/html");
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    controlled(body);
    expect(body.error).not.toMatch(/</);
  });

  it("a refusal names only Channels' error code, never its free text", async () => {
    answer(400, JSON.stringify({ success: false, error: "<script>steal()</script> visit evil.example", data: { code: "INVALID_PARAMS" } }));
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    expect(body.error).toBe("The fee relayer refused this transaction (INVALID_PARAMS). Nothing was sent.");
  });

  it("a refusal with a code that is not a code shape drops it (and is treated as possibly sent)", async () => {
    answer(400, JSON.stringify({ success: false, error: "x", data: { code: "go to evil.example" } }));
    const { body } = await pay();
    expect(body.error).toBe("The fee relayer could not confirm this transaction. Check your activity before trying again.");
    expect(body.error).not.toMatch(/evil/);
  });

  it("Channels does not answer in time: 502 within the configured timeout", async () => {
    vi.stubEnv("CHANNELS_TIMEOUT_MS", "300");
    fakeChannels.reply = () => {}; // never answers
    const t0 = Date.now();
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    controlled(body);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("Channels cannot be reached at all: 502", async () => {
    vi.stubEnv("CHANNELS_BASE_URL", "http://127.0.0.1:9"); // discard port, nothing listens
    const { r, body } = await pay();
    expect(r.status).toBe(502);
    controlled(body);
  });
});

describe("Channels error codes: refused before sending vs. outcome unknown (adversary r3b)", () => {
  it("a check that runs before sending (TIMEBOUNDS_EXPIRED) says nothing was sent", async () => {
    answer(400, JSON.stringify({ success: false, error: "x", data: { code: "TIMEBOUNDS_EXPIRED" } }));
    const { body } = await pay();
    expect(body.error).toBe("The fee relayer refused this transaction (TIMEBOUNDS_EXPIRED). Nothing was sent.");
  });

  it("a transaction that landed and failed (ONCHAIN_FAILED) says nothing changed", async () => {
    answer(400, JSON.stringify({ success: false, error: "x", data: { code: "ONCHAIN_FAILED" } }));
    const { body } = await pay();
    expect(body.error).toBe("This transaction failed on the network (ONCHAIN_FAILED), so nothing changed.");
  });

  it("an unknown code is treated as possibly sent", async () => {
    answer(500, JSON.stringify({ success: false, error: "x", data: { code: "KV_ERROR" } }));
    const { body } = await pay();
    expect(body.error).toBe("The fee relayer could not confirm this transaction (KV_ERROR). Check your activity before trying again.");
  });

  it("a refusal with no code is treated as possibly sent", async () => {
    answer(500, JSON.stringify({ success: false, error: "x" }));
    const { body } = await pay();
    expect(body.error).toBe("The fee relayer could not confirm this transaction. Check your activity before trying again.");
  });
});
