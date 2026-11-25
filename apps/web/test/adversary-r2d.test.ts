import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { WALLET, SPLIT_ID, transferArgs } from "./relay-fixtures";

function instanceEntry(contractId: string, hash: string) {
  const inst = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, "hex")),
    storage: null,
  });
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(contractId).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(inst),
  });
  return { val: xdr.LedgerEntryData.contractData(data) };
}

// A real USDC transfer from the passkey wallet, authorised by the wallet. Chain lookup mocked (wallet runs the account wasm).
function genuine() {
  const args = transferArgs(WALLET, SPLIT_ID);
  const fn = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args }),
  );
  const af = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args }),
  );
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString("9"),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: af, subInvocations: [] }),
  });
  return { func: fn.toXDR("base64"), auth: [entry.toXDR("base64")] };
}

async function post(upstream: () => Promise<Response>) {
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({
    entries: [instanceEntry(WALLET, SMART_ACCOUNT.accountWasmHash)],
  })) as never);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async () => upstream()));
  void realFetch;
  const { POST } = await import("../src/app/api/relay/route");
  const req = new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(genuine()) });
  return POST(req);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("adv r2d relay route", () => {
  it("baseline: genuine transfer is forwarded and the upstream answer returned", async () => {
    const r = await post(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(r.status).toBe(200);
  });
  it("upstream body that fails mid-read (the 60s timeout covers the body) gives the documented JSON 502, not an unhandled throw", async () => {
    const r = await post(async () => {
      const res = new Response("x", { status: 200 });
      vi.spyOn(res, "text").mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return res;
    });
    expect(r.status).toBe(502);
    expect((await r.json()).success).toBe(false);
  });
  it("upstream 204/304 answer is passed on instead of crashing the route", async () => {
    const r = await post(async () => new Response(null, { status: 204 }));
    expect(r.status).toBe(204);
  });
});
void nativeToScVal;
