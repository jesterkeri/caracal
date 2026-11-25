import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkPayload } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { TOKENS } from "../src/lib/stellar/config";
import { WALLET, SPLIT_ID, transferArgs, lookupWasm, lookupInstance } from "./relay-fixtures";

const call = () =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
const func = () => xdr.HostFunction.hostFunctionTypeInvokeContract(call()).toXDR("base64");
const entry = () =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call()), subInvocations: [] }),
  }).toXDR("base64");
const check = (b: unknown) => checkPayload(b, CARACAL_POLICY, lookupWasm, lookupInstance);

describe("adv r2e relay: only canonical base64 XDR strings are forwarded verbatim", () => {
  it("baseline", async () => {
    expect((await check({ func: func(), auth: [entry()] })).ok).toBe(true);
  });
  it("func containing non-base64 characters is refused", async () => {
    const f = func();
    const v = await check({ func: f.slice(0, 8) + "!!\n ##" + f.slice(8), auth: [entry()] });
    expect(v.ok).toBe(false);
  });
  it("auth entry with a '=' mid-string followed by hidden bytes is refused", async () => {
    const a = entry();
    const v = await check({ func: func(), auth: [a + "=" + Buffer.from("hidden payload").toString("base64")] });
    expect(v.ok).toBe(false);
  });
});

// ---- route: every answer must be the documented JSON shape ----
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";

function walletInstance() {
  const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null });
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(WALLET).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(inst),
  });
  return { val: xdr.LedgerEntryData.contractData(data) };
}
async function post(upstream: () => Promise<Response>) {
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [walletInstance()] })) as never);
  vi.stubGlobal("fetch", vi.fn(async () => upstream()));
  const { POST } = await import("../src/app/api/relay/route");
  return POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify({ func: func(), auth: [entry()] }) }));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("adv r2e relay route answers", () => {
  it("an upstream HTML error page (e.g. a 502 from the relayer's CDN) is not handed to the client as HTML", async () => {
    const r = await post(async () => new Response("<html><body>Bad gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } }));
    expect(r.headers.get("content-type") ?? "").toMatch(/json/);
    expect(typeof (await r.clone().json().catch(() => ({}))).success).toBe("boolean");
  });
  it("an upstream 200 with an empty body is not handed to the client as an empty 'application/json' answer", async () => {
    const r = await post(async () => new Response("", { status: 200 }));
    const j = await r.json().catch(() => null);
    expect(j && typeof j.success).toBe("boolean");
  });
});
