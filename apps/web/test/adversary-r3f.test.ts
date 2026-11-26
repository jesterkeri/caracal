// Adversary r3f: attacks on the relay's Channels answer handling.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const { POST } = await import("../src/app/api/relay/route");
  const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
  return { r, body: (await r.json()) as { success: boolean; data?: { hash?: unknown; transactionId?: unknown; status?: unknown }; error?: string } };
}

describe("adv r3f: Channels answer is rebuilt like the proxy's answer (64-hex hash, string id)", () => {
  it("a confirmed answer whose hash is free text is not passed on as a transaction hash", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { transactionId: "tx-1", hash: "<b>Call +234 800 to unlock your funds</b>", status: "confirmed" }, error: null }));
    };
    const { r, body } = await pay();
    // Wallet creation (proxy path) accepts only a 64-hex hash; the payment path must not show upstream free text either.
    expect(body.success === true ? String(body.data?.hash) : "refused").toMatch(/^([0-9a-f]{64}|refused)$/i);
    void r;
  });

  it("a non-string transactionId object is not passed on", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { transactionId: { html: "<b>x</b>" }, hash: "ab".repeat(32), status: "confirmed" }, error: null }));
    };
    const { body } = await pay();
    if (body.success) expect(typeof body.data?.transactionId === "string" || body.data?.transactionId === null).toBe(true);
  });
});
