// The transactions the split page signs, read back from their XDR, and checked
// against Caracal's own sponsorship policy (what /api/relay would allow).
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { checkPayload } from "../src/lib/relay/policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_SALT, contractAddressFrom, splitAddressFor } from "../src/lib/stellar/split-address";
import { deploySplitFunction, moveFunction, setSplitFunction, withdrawFunction } from "../src/lib/split/calls";
import { WALLET, splitStorage } from "./relay-fixtures";

const SPLIT_ADDR = splitAddressFor(WALLET);

const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");

// The chain as the policy sees it: the wallet, and (once deployed) its split.
const lookupWasm = async (id: string) => (id === WALLET ? SMART_ACCOUNT.accountWasmHash : id === SPLIT_ADDR ? SPLIT.wasmHash : null);
const lookupInstance = async (id: string) => (id === SPLIT_ADDR ? splitStorage(WALLET) : null);

function deployPayload(tax: number, goal: number) {
  const func = deploySplitFunction(WALLET, tax, goal);
  return {
    func: func.toXDR("base64"),
    auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(func.createContractV2()))],
  };
}
function callPayload(func: xdr.HostFunction) {
  return { func: func.toXDR("base64"), auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func.invokeContract()))] };
}

describe("deploying the split", () => {
  it("is createContractV2 from the wallet's own address with SPLIT_SALT, so it lands at splitAddressFor(wallet)", () => {
    const args = deploySplitFunction(WALLET, 1000, 1500).createContractV2();
    const from = args.contractIdPreimage().fromAddress();
    expect(Address.fromScAddress(from.address()).toString()).toBe(WALLET);
    expect(Buffer.from(from.salt()).equals(SPLIT_SALT)).toBe(true);
    // The address the network gives this deployment is the address the page shows.
    expect(contractAddressFrom(Address.fromScAddress(from.address()).toString(), Buffer.from(from.salt()))).toBe(SPLIT_ADDR);
    expect(Buffer.from(args.executable().wasmHash()).toString("hex")).toBe(SPLIT.wasmHash);
  });
  it("passes the constructor (owner = the wallet, token = USDC, tax_bps, goal_bps)", () => {
    const ctor = deploySplitFunction(WALLET, 1250, 500).createContractV2().constructorArgs().map((v) => scValToNative(v));
    expect(ctor).toEqual([WALLET, TOKENS.usdc, 1250, 500]);
  });
  it("is allowed by the relay's sponsorship policy", async () => {
    const v = await checkPayload(deployPayload(1000, 1500), CARACAL_POLICY, lookupWasm, lookupInstance);
    expect(v.ok).toBe(true);
  });
});

describe("calls on the split contract", () => {
  it("withdraw(pot, to, amount) names the pot, the wallet and an i128 amount", () => {
    const call = withdrawFunction(SPLIT_ADDR, "Tax", WALLET, BigInt(125_000_000)).invokeContract();
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(SPLIT_ADDR);
    expect(call.functionName().toString()).toBe("withdraw");
    const [pot, to, amount] = call.args();
    expect(scValToNative(pot)).toEqual(["Tax"]);
    expect(scValToNative(to)).toBe(WALLET);
    expect(pot.switch().name).toBe("scvVec");
    expect(amount.switch().name).toBe("scvI128");
    expect(scValToNative(amount)).toBe(BigInt(125_000_000));
  });
  it("move_between(from_pot, to_pot, amount) and set_split(tax_bps, goal_bps)", () => {
    const m = moveFunction(SPLIT_ADDR, "Spend", "Goal", BigInt(5)).invokeContract();
    expect(m.functionName().toString()).toBe("move_between");
    expect(m.args().map((v) => scValToNative(v))).toEqual([["Spend"], ["Goal"], BigInt(5)]);
    const s = setSplitFunction(SPLIT_ADDR, 700, 300).invokeContract();
    expect(s.functionName().toString()).toBe("set_split");
    expect(s.args().map((v) => v.switch().name)).toEqual(["scvU32", "scvU32"]);
    expect(s.args().map((v) => scValToNative(v))).toEqual([700, 300]);
  });
  it("are all allowed by the relay's sponsorship policy once the split exists", async () => {
    for (const f of [withdrawFunction(SPLIT_ADDR, "Spend", WALLET, BigInt(1)), moveFunction(SPLIT_ADDR, "Tax", "Spend", BigInt(1)), setSplitFunction(SPLIT_ADDR, 1, 2)]) {
      const v = await checkPayload(callPayload(f), CARACAL_POLICY, lookupWasm, lookupInstance);
      expect(v.ok, JSON.stringify(v)).toBe(true);
    }
  });
});
