// Adversary r2a relay finding and its wider class: every authorising address is
// a Caracal passkey wallet (or the shared deployer deploying a wallet), and every
// contract whose code runs is Caracal's.
import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { checkPayload, type InstanceLookup } from "../src/lib/relay/policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import {
  CLI_OWNER,
  SHARED_DEPLOYER,
  SPLIT_ID,
  WALLET,
  depositArgs,
  lookupInstance,
  lookupWasm,
  splitCtorArgs,
  splitStorage,
  transferArgs,
  walletCtorArgs,
} from "./relay-fixtures";
// Fixture fix (2026-11-27, adversary s2): a sponsored split deploy uses Caracal's split salt, so it lands at the wallet's own split address.
import { SPLIT_SALT } from "../src/lib/stellar/split-address";

const OUTSIDER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"; // Soroswap testnet router

const check = (body: unknown, inst: InstanceLookup = lookupInstance) =>
  checkPayload(body, CARACAL_POLICY, lookupWasm, inst);

const call = (c: string, fn: string, args: xdr.ScVal[]) =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(c).toScAddress(), functionName: fn, args });
const invoke = (c: string, fn: string, args: xdr.ScVal[]) =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(call(c, fn, args)).toXDR("base64");

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
const contractFn = (c: string, fn: string, args: xdr.ScVal[]) =>
  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call(c, fn, args));

function deployArgs(from: string, wasm: string, ctor: xdr.ScVal[]) {
  return new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(from).toScAddress(), salt: SPLIT_SALT }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")),
    constructorArgs: ctor,
  });
}
function deploy(from: string, wasm: string, ctor: xdr.ScVal[]) {
  const a = deployArgs(from, wasm, ctor);
  const func = xdr.HostFunction.hostFunctionTypeCreateContractV2(a).toXDR("base64");
  const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(a);
  return { func, auth: [entry(from, fn)] };
}

const walletDeposit = () => entry(WALLET, contractFn(SPLIT_ID, "deposit", depositArgs()));

describe("payers and signers are passkey wallets", () => {
  it("a wallet's real deposit is sponsored", async () => {
    expect((await check({ func: invoke(SPLIT_ID, "deposit", depositArgs()), auth: [walletDeposit()] })).ok).toBe(true);
  });

  it("USDC transfer whose sender is a classic account (could be the relayer) is refused", async () => {
    const v = await check({ func: invoke(TOKENS.usdc, "transfer", transferArgs(CLI_OWNER)), auth: [walletDeposit()] });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("deposit paid from a classic account (implicit source auth) is refused", async () => {
    const v = await check({ func: invoke(SPLIT_ID, "deposit", depositArgs(CLI_OWNER)), auth: [walletDeposit()] });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("deposit paid from a contract that is not a passkey wallet is refused", async () => {
    const v = await check({ func: invoke(SPLIT_ID, "deposit", depositArgs(OUTSIDER)), auth: [walletDeposit()] });
    expect(v.ok).toBe(false);
  });

  it("an auth entry signed by a contract that is not a passkey wallet is refused", async () => {
    const e = entry(OUTSIDER, contractFn(SPLIT_ID, "deposit", depositArgs()));
    expect((await check({ func: invoke(SPLIT_ID, "deposit", depositArgs()), auth: [e] })).ok).toBe(false);
  });

  it("a classic account may sign only a wallet deployment", async () => {
    const e = entry(CLI_OWNER, contractFn(SPLIT_ID, "deposit", depositArgs()));
    expect((await check({ func: invoke(SPLIT_ID, "deposit", depositArgs()), auth: [e] })).ok).toBe(false);
  });
});

describe("deployments", () => {
  it("the kit's shared deployer deploying a passkey wallet is sponsored (shape of tx 1559440b)", async () => {
    expect((await check(deploy(SHARED_DEPLOYER, SMART_ACCOUNT.accountWasmHash, walletCtorArgs()))).ok).toBe(true);
  });

  it("a wallet with a verifier other than the WebAuthn verifier is refused", async () => {
    expect((await check(deploy(SHARED_DEPLOYER, SMART_ACCOUNT.accountWasmHash, walletCtorArgs(OUTSIDER)))).ok).toBe(false);
  });

  it("a wallet created with policies is refused", async () => {
    expect((await check(deploy(SHARED_DEPLOYER, SMART_ACCOUNT.accountWasmHash, walletCtorArgs(undefined, true)))).ok).toBe(false);
  });

  it("a passkey wallet deploying its split contract over USDC is sponsored", async () => {
    expect((await check(deploy(WALLET, SPLIT.wasmHash, splitCtorArgs()))).ok).toBe(true);
  });

  it("a split contract owned by a classic account is refused", async () => {
    expect((await check(deploy(WALLET, SPLIT.wasmHash, splitCtorArgs(CLI_OWNER)))).ok).toBe(false);
  });

  it("a classic account (shared deployer) deploying a split contract is refused", async () => {
    expect((await check(deploy(SHARED_DEPLOYER, SPLIT.wasmHash, splitCtorArgs()))).ok).toBe(false);
  });

  it("a deployment no auth entry authorises exactly is refused (relayer would be the implicit deployer)", async () => {
    const unauthorised = deploy(WALLET, SPLIT.wasmHash, splitCtorArgs(WALLET, TOKENS.usdc));
    const other = deploy(WALLET, SMART_ACCOUNT.accountWasmHash, walletCtorArgs());
    expect((await check({ func: unauthorised.func, auth: other.auth })).ok).toBe(false);
  });
});

describe("deployed split contracts must be Caracal's", () => {
  const withStorage = (s: xdr.ScMapEntry[] | null): InstanceLookup => async (id) => (id === SPLIT_ID ? s : null);
  const body = { func: invoke(SPLIT_ID, "deposit", depositArgs()), auth: [walletDeposit()] };

  it("a split contract over another token is refused", async () => {
    expect((await check(body, withStorage(splitStorage(WALLET, OUTSIDER)))).ok).toBe(false);
  });

  it("a split contract owned by a classic account is refused (like the CLI-owned demo instance)", async () => {
    expect((await check(body, withStorage(splitStorage(CLI_OWNER))))).toMatchObject({ ok: false, status: 403 });
  });

  it("a split contract whose storage cannot be read is refused with 503", async () => {
    const failing: InstanceLookup = async () => {
      throw new Error("rpc down");
    };
    expect(await check(body, failing)).toMatchObject({ ok: false, status: 503 });
  });
});
