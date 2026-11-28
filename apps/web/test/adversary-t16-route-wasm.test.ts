import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, SPLIT } from "../src/lib/stellar/config";
import { fakeChannels, simulated } from "./setup-relay-server";
import { WALLET, depositArgs, splitCtorArgs, splitStorage } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
const EARLIER_SPLIT = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const NEW_SPLIT = "CAI7VA2CZLCFNJ23BSYSU3PNCGF2VMWVH64TD4XTQPYTR6PKPZI5YJXB";
const wasmOf: Record<string, string> = { [WALLET]: SMART_ACCOUNT.accountWasmHash, [EARLIER_SPLIT]: SPLIT.earlierWasmHashes[0], [NEW_SPLIT]: SPLIT.wasmHash };
function chainState() {
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async (key: xdr.LedgerKey) => {
    const id = Address.fromScAddress(key.contractData().contract()).toString();
    const h = wasmOf[id];
    if (!h) return { entries: [] };
    const storage = id === WALLET ? null : splitStorage();
    const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(h, "hex")), storage });
    const data = new xdr.ContractDataEntry({ ext: new xdr.ExtensionPoint(0), contract: Address.fromString(id).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent(), val: xdr.ScVal.scvContractInstance(inst) });
    return { entries: [{ val: xdr.LedgerEntryData.contractData(data) }] };
  }) as never);
}
const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");
const deposit = (split: string) => {
  const a = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(split).toScAddress(), functionName: "deposit", args: depositArgs() });
  return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(a).toXDR("base64"), auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(a))] };
};
const deploy = (wasm: string) => {
  const a = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: Buffer.alloc(32, 1) })),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")),
    constructorArgs: splitCtorArgs(),
  });
  return { func: xdr.HostFunction.hostFunctionTypeCreateContractV2(a).toXDR("base64"), auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(a))] };
};
async function post(body: unknown, code: string[]) {
  chainState();
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => simulated(code));
  const { POST } = await import("../src/app/api/relay/route");
  return POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) }));
}
describe("t16 route wasm", () => {
  it("earlier split deposit is sponsored", async () => {
    const r = await post(deposit(EARLIER_SPLIT), [SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash, SPLIT.earlierWasmHashes[0]]);
    expect(r.status).toBe(200);
    expect(fakeChannels.requests).toHaveLength(1);
  });
  it("new split deposit is sponsored", async () => {
    const r = await post(deposit(NEW_SPLIT), [SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash, SPLIT.wasmHash]);
    expect(r.status).toBe(200);
  });
  it("new split deploy is sponsored", async () => {
    const r = await post(deploy(SPLIT.wasmHash), [SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash, SPLIT.wasmHash]);
    expect(r.status).toBe(200);
  });
  it("earlier split deploy is refused, nothing sent", async () => {
    const r = await post(deploy(SPLIT.earlierWasmHashes[0]), [SMART_ACCOUNT.accountWasmHash, SPLIT.earlierWasmHashes[0]]);
    expect(r.status).toBe(403);
    expect(fakeChannels.requests).toHaveLength(0);
    expect((await r.json()).error).toMatch(/Nothing was sent/);
  });
});
