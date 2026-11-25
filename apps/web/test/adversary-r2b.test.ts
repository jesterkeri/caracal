// Adversary r2b: relay policy attacks.
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { checkPayload } from "../src/lib/relay/policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import {
  CLI_OWNER, SHARED_DEPLOYER, SPLIT_ID, WALLET, addr, depositArgs, lookupInstance, lookupWasm,
  splitCtorArgs, transferArgs, walletCtorArgs,
} from "./relay-fixtures";

const check = (body: unknown) => checkPayload(body, CARACAL_POLICY, lookupWasm, lookupInstance);
const call = (c: string, fn: string, args: xdr.ScVal[]) =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(c).toScAddress(), functionName: fn, args });
const invoke = (c: string, fn: string, args: xdr.ScVal[]) =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(call(c, fn, args)).toXDR("base64");
const contractFn = (c: string, fn: string, args: xdr.ScVal[]) =>
  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call(c, fn, args));
function entry(signer: string, fn: xdr.SorobanAuthorizedFunction, subs: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: xdr.Int64.fromString("11"),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: subs }),
  }).toXDR("base64");
}
const inv = (fn: xdr.SorobanAuthorizedFunction, subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: subs });
function deployArgs(deployer: string, wasm: string, ctor: xdr.ScVal[]) {
  return new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt: Buffer.alloc(32, 7) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")),
    constructorArgs: ctor,
  });
}

describe("deployer binding", () => {
  it("deployment whose deployer (preimage address) is the relayer/source account is refused even if a wallet signs an identical root", async () => {
    // CLI_OWNER stands for the relayer's own classic account: it never signs, so the host
    // would authorise it implicitly as the transaction source.
    const a = deployArgs(CLI_OWNER, SPLIT.wasmHash, splitCtorArgs());
    const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(a);
    const v = await check({
      func: xdr.HostFunction.hostFunctionTypeCreateContractV2(a).toXDR("base64"),
      auth: [entry(WALLET, fn)],
    });
    expect(v).toMatchObject({ ok: false });
  });

  it("wallet deployment by an arbitrary classic deployer (not the kit's shared deployer) is refused", async () => {
    const a = deployArgs(CLI_OWNER, SMART_ACCOUNT.accountWasmHash, walletCtorArgs());
    const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(a);
    const v = await check({
      func: xdr.HostFunction.hostFunctionTypeCreateContractV2(a).toXDR("base64"),
      auth: [entry(CLI_OWNER, fn)],
    });
    expect(v).toMatchObject({ ok: false });
  });

  it("entry signed by shared deployer but preimage deployer is another account is refused", async () => {
    const a = deployArgs(CLI_OWNER, SMART_ACCOUNT.accountWasmHash, walletCtorArgs());
    const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(a);
    const v = await check({
      func: xdr.HostFunction.hostFunctionTypeCreateContractV2(a).toXDR("base64"),
      auth: [entry(SHARED_DEPLOYER, fn)],
    });
    expect(v).toMatchObject({ ok: false });
  });
});

describe("genuine actions", () => {
  const amt = nativeToScVal(BigInt(500000), { type: "i128" });
  it("deposit with its USDC transfer sub-invocation is sponsored", async () => {
    const sub = inv(contractFn(TOKENS.usdc, "transfer", transferArgs()));
    const v = await check({
      func: invoke(SPLIT_ID, "deposit", depositArgs()),
      auth: [entry(WALLET, contractFn(SPLIT_ID, "deposit", depositArgs()), [sub])],
    });
    expect(v.ok).toBe(true);
  });
  it("wallet.execute(withdraw) is sponsored", async () => {
    const wargs = [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Spend")]), addr(CLI_OWNER), amt];
    const exArgs = [addr(SPLIT_ID), xdr.ScVal.scvSymbol("withdraw"), xdr.ScVal.scvVec(wargs)];
    const v = await check({
      func: invoke(WALLET, "execute", exArgs),
      auth: [entry(WALLET, contractFn(WALLET, "execute", exArgs), [inv(contractFn(SPLIT_ID, "withdraw", wargs))])],
    });
    expect(v.ok).toBe(true);
  });
  it("USDC transfer from wallet to a classic address is sponsored", async () => {
    const t = transferArgs(WALLET, CLI_OWNER);
    const v = await check({ func: invoke(TOKENS.usdc, "transfer", t), auth: [entry(WALLET, contractFn(TOKENS.usdc, "transfer", t))] });
    expect(v.ok).toBe(true);
  });
  it("wallet deploys its split contract with USDC, shared deployer deploys wallet", async () => {
    const a = deployArgs(SHARED_DEPLOYER, SMART_ACCOUNT.accountWasmHash, walletCtorArgs());
    const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(a);
    const v = await check({ func: xdr.HostFunction.hostFunctionTypeCreateContractV2(a).toXDR("base64"), auth: [entry(SHARED_DEPLOYER, fn)] });
    expect(v.ok).toBe(true);
  });
});
