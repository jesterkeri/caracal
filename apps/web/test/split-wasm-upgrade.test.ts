// Split wasm upgrade (2026-11-28, Joshua approved the upload): the split wasm with the constructor's `created`
// event (ca6bef...) is now the only one the relay deploys and the only one the tax estimate reads. Splits already
// deployed from the earlier wasm (b97d71...) keep working through the relay, so their USDC is never stranded, but no
// new split is deployed from it: a split's address is fixed per wallet, so a wallet given that wasm could never
// get a tax estimate.
import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkPayload } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { SMART_ACCOUNT, SPLIT, SPLIT_CALLABLE_WASM } from "../src/lib/stellar/config";
import { WALLET, argsFor, splitCtorArgs, splitStorage } from "./relay-fixtures";

const NEW = "ca6befd2b75c60ef2b3019667c11e26e675364aa4b0380783d8589b62d07f56c";
const EARLIER = "b97d71c33aa88dbc12bacb07f4903590e2a0ad4fc4729219e8e9c94d6c2f8c58";
const EARLIER_SPLIT = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const NEW_SPLIT = "CAI7VA2CZLCFNJ23BSYSU3PNCGF2VMWVH64TD4XTQPYTR6PKPZI5YJXB";

const chain: Record<string, string> = { [EARLIER_SPLIT]: EARLIER, [NEW_SPLIT]: NEW, [WALLET]: SMART_ACCOUNT.accountWasmHash };
const lookup = async (id: string) => chain[id] ?? null;
const instance = async (id: string) => (id === EARLIER_SPLIT || id === NEW_SPLIT ? splitStorage() : null);
const check = (body: unknown) => checkPayload(body, CARACAL_POLICY, lookup, instance);

const callArgs = (contract: string, fn: string) =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contract).toScAddress(), functionName: fn, args: argsFor(fn) });
const deployArgs = (wasm: string) =>
  new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: Buffer.alloc(32, 1) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")),
    constructorArgs: splitCtorArgs(),
  });
const auth = (fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString("9"),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");
const call = (contract: string, fn: string) => ({
  func: xdr.HostFunction.hostFunctionTypeInvokeContract(callArgs(contract, fn)).toXDR("base64"),
  auth: [auth(xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(callArgs(contract, fn)))],
});
const deploy = (wasm: string) => ({
  func: xdr.HostFunction.hostFunctionTypeCreateContractV2(deployArgs(wasm)).toXDR("base64"),
  auth: [auth(xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(deployArgs(wasm)))],
});

describe("split wasm upgrade", () => {
  it("pins the uploaded wasm, and keeps only the 2026-11-25 wasm as earlier", () => {
    expect(SPLIT.wasmHash).toBe(NEW);
    expect(SPLIT_CALLABLE_WASM).toEqual([NEW, EARLIER]);
  });

  it("deploys a split from the new wasm", async () => {
    expect(await check(deploy(NEW))).toMatchObject({ ok: true });
  });

  it("no longer deploys a split from the earlier wasm", async () => {
    expect(await check(deploy(EARLIER))).toMatchObject({ ok: false, status: 403 });
  });

  it("still sponsors calls on a split deployed from the earlier wasm, so its USDC is not stranded", async () => {
    for (const fn of ["deposit", "withdraw", "move_between", "set_split"]) {
      expect(await check(call(EARLIER_SPLIT, fn))).toMatchObject({ ok: true });
    }
  });

  it("sponsors the same calls on a split from the new wasm", async () => {
    for (const fn of ["deposit", "withdraw", "move_between", "set_split"]) {
      expect(await check(call(NEW_SPLIT, fn))).toMatchObject({ ok: true });
    }
  });

  it("an earlier split still has to hold USDC and be owned by a passkey wallet", async () => {
    const notWallet = async (id: string) => (id === EARLIER_SPLIT ? splitStorage("GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX") : null);
    const v = await checkPayload(call(EARLIER_SPLIT, "withdraw"), CARACAL_POLICY, lookup, notWallet);
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("a deposit into an earlier split still needs a passkey wallet as the payer", async () => {
    expect(CARACAL_POLICY.callRules.has(`${EARLIER}:deposit`)).toBe(true);
    expect(CARACAL_POLICY.callRules.has(`${NEW}:deposit`)).toBe(true);
  });
});
