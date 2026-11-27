import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { checkPayload } from "../src/lib/relay/policy";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { lookupWasm } from "./relay-fixtures";
// Fixture fix (2026-11-27, adversary s2): a sponsored split deploy uses Caracal's split salt, so it lands at the wallet's own split address.
import { SPLIT_SALT } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
// Soroswap testnet router: a real contract, not on the allowlist.
const OUTSIDER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
// Fixture fix (2026-11-25): WALLET must be a passkey wallet for the baseline to be a real Caracal action.
const lookup = lookupWasm;

const preimage = () =>
  xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: SPLIT_SALT }),
  );
const splitDeploy = (token: string) => {
  const args = [
    nativeToScVal(Address.fromString(WALLET)),
    nativeToScVal(Address.fromString(token)),
    xdr.ScVal.scvU32(1000),
    xdr.ScVal.scvU32(1500),
  ];
  const exe = xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT.wasmHash, "hex"));
  const fn = xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({ contractIdPreimage: preimage(), executable: exe, constructorArgs: args }),
  );
  const authFn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
    new xdr.CreateContractArgsV2({ contractIdPreimage: preimage(), executable: exe, constructorArgs: args }),
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
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: authFn, subInvocations: [] }),
  });
  return { func: fn.toXDR("base64"), auth: [entry.toXDR("base64")] };
};

describe("adv r2a relay", () => {
  it("baseline: split deploy with USDC token is sponsored", async () => {
    expect((await checkPayload(splitDeploy(TOKENS.usdc), CARACAL_POLICY, lookup)).ok).toBe(true);
  });
  it("split deploy whose constructor token is an outside contract is NOT sponsored", async () => {
    const v = await checkPayload(splitDeploy(OUTSIDER), CARACAL_POLICY, lookup);
    expect(v.ok).toBe(false);
  });
});
