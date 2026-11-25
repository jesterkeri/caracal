import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkPayload, readBounded, WindowLimiter, clientKey } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const POLICY = CARACAL_POLICY;
const lookup = async (id: string) => (id === WALLET ? SMART_ACCOUNT.accountWasmHash : null);
const args = (c: string, fn: string) => new xdr.InvokeContractArgs({ contractAddress: Address.fromString(c).toScAddress(), functionName: fn, args: [] });
const invoke = (c: string, fn: string) => xdr.HostFunction.hostFunctionTypeInvokeContract(args(c, fn)).toXDR();
const mkAuth = (sub = false) => {
  const inner = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args(TOKENS.xlm, "transfer")), subInvocations: [] });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("1"), signatureExpirationLedger: 10, signature: xdr.ScVal.scvVoid() })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args(TOKENS.usdc, "transfer")), subInvocations: sub ? [inner] : [] }),
  }).toXDR();
};
const b64 = (b: Buffer) => b.toString("base64");
const check = (b: unknown) => checkPayload(b, POLICY, lookup);

describe("adv r1 relay", () => {
  it("baseline", async () => { expect((await check({ func: b64(invoke(TOKENS.usdc, "transfer")), auth: [b64(mkAuth())] })).ok).toBe(true); });
  it("func with trailing bytes refused", async () => {
    const v = await check({ func: b64(Buffer.concat([invoke(TOKENS.usdc, "transfer"), Buffer.from([1, 2, 3, 4])])), auth: [b64(mkAuth())] });
    expect(v.ok).toBe(false);
  });
  it("auth with trailing bytes refused", async () => {
    const v = await check({ func: b64(invoke(TOKENS.usdc, "transfer")), auth: [b64(Buffer.concat([mkAuth(), Buffer.alloc(4)]))] });
    expect(v.ok).toBe(false);
  });
  it("extra keys / proto", async () => {
    const base = { func: b64(invoke(TOKENS.usdc, "transfer")), auth: [b64(mkAuth())] };
    expect((await check({ ...base, xdr: "x" })).ok).toBe(false);
    expect((await check(JSON.parse(`{"func":"${base.func}","auth":["${base.auth[0]}"],"__proto__":{}}`))).ok).toBe(false);
    expect((await check([])).ok).toBe(false);
    expect((await check({ func: base.func, auth: [] })).ok).toBe(false);
    expect((await check({ func: base.func, auth: Array(9).fill(base.auth[0]) })).ok).toBe(false);
    expect((await check({ func: base.func, auth: Array(8).fill(base.auth[0]) })).ok).toBe(true);
  });
  it("account/muxed/ non-contract target does not throw", async () => {
    const f = xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({ contractAddress: Address.fromString("GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX").toScAddress(), functionName: "transfer", args: [] })).toXDR();
    const v = await check({ func: b64(f), auth: [b64(mkAuth())] });
    expect(v.ok).toBe(false);
  });
  it("createContract v1 / V2 with SAC executable refused", async () => {
    const pre = xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: Buffer.alloc(32) }));
    const v2 = xdr.HostFunction.hostFunctionTypeCreateContractV2(new xdr.CreateContractArgsV2({ contractIdPreimage: pre, executable: xdr.ContractExecutable.contractExecutableStellarAsset(), constructorArgs: [] })).toXDR();
    expect((await check({ func: b64(v2), auth: [b64(mkAuth())] })).ok).toBe(false);
    const v1 = xdr.HostFunction.hostFunctionTypeCreateContract(new xdr.CreateContractArgs({ contractIdPreimage: pre, executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT.wasmHash, "hex")) })).toXDR();
    expect((await check({ func: b64(v1), auth: [b64(mkAuth())] })).ok).toBe(false);
  });
  it("uppercase hash in allowlist wasm still matches only lowercase", async () => {
    const pre = xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: Buffer.alloc(32) }));
    const bad = Buffer.from(SPLIT.wasmHash, "hex"); bad[0] ^= 1;
    const f = xdr.HostFunction.hostFunctionTypeCreateContractV2(new xdr.CreateContractArgsV2({ contractIdPreimage: pre, executable: xdr.ContractExecutable.contractExecutableWasm(bad), constructorArgs: [] })).toXDR();
    expect((await check({ func: b64(f), auth: [b64(mkAuth())] })).ok).toBe(false);
  });
  it("bounded read: lying content-length, stream over limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 1000) c.close(); else c.enqueue(new Uint8Array(1024)); } });
    const req = new Request("http://x/", { method: "POST", body: stream, headers: { "content-length": "10" }, duplex: "half" } as RequestInit);
    expect(await readBounded(req)).toBeNull();
    expect(pulled).toBeLessThan(100);
  });
  it("bounded read: unicode bytes", async () => {
    const s = "é".repeat(33 * 1024); // 66KB bytes, 33K chars
    expect(await readBounded(new Request("http://x/", { method: "POST", body: s }))).toBeNull();
    expect(await readBounded(new Request("http://x/", { method: "POST", body: "a".repeat(65536) }))).toHaveLength(65536);
    expect(await readBounded(new Request("http://x/", { method: "POST", body: "a".repeat(65537) }))).toBeNull();
  });
  it("limiter", () => {
    const l = new WindowLimiter(2, 1000, 3);
    expect([l.take("a", 0), l.take("a", 1), l.take("a", 2), l.take("a", 1000)]).toEqual([true, true, false, true]);
    expect(l.take("b", 0)).toBe(true); expect(l.take("c", 0)).toBe(true);
    expect(l.take("d", 1)).toBe(false);
    expect(l.take("d", 2000)).toBe(true);
  });
});
