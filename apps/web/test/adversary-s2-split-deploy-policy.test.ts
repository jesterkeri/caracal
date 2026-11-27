// Adversary s2: the relay's sponsorship policy for deploying a split contract
// checks only that the owner is SOME Caracal passkey wallet and that the token is
// USDC. It never checks that the owner is the wallet that signs the deployment,
// nor that the deployment uses SPLIT_SALT, the fixed salt that makes a split's
// address a function of its wallet.
//
// Spec:
// - docs/decisions.md 2026-11-25: "One split contract per user, constructor-initialised".
// - src/app/split/page.tsx: "Your wallet deploys it at a fixed address ... so it
//   cannot be deployed twice. Caracal pays the fee."
// - README "Who can move money": the relay passes on "split contract calls ...
//   where every ... owner ... is a Caracal passkey wallet" (a split another wallet
//   owns is not the signer's own split).
// Attacker goals 2 and 3: a second split contract for one wallet, or a split
// deployed for a wallet that is not the one deploying it, paid for by the sponsor.
import { Address, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { checkPayload } from "../src/lib/relay/policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_SALT, contractAddressFrom, splitAddressFor } from "../src/lib/stellar/split-address";
import { deploySplitFunction } from "../src/lib/split/calls";
import { WALLET } from "./relay-fixtures";

// A second, different passkey wallet (a valid contract address, running the wallet wasm below).
const OTHER_WALLET = StrKey.encodeContract(Buffer.alloc(32, 7));

const address = (a: string) => xdr.ScVal.scvAddress(Address.fromString(a).toScAddress());

/** The same createContractV2 the page builds, but with a chosen salt and constructor owner. */
function deployFrom(deployer: string, salt: Buffer, owner: string): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT.wasmHash, "hex")),
      constructorArgs: [address(owner), address(TOKENS.usdc), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)],
    }),
  );
}

/** The payload the kit would post: the host function and the deployer wallet's own auth entry over it. */
function payload(func: xdr.HostFunction, signer: string) {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(func.createContractV2()),
      subInvocations: [],
    }),
  });
  return { func: func.toXDR("base64"), auth: [entry.toXDR("base64")] };
}

// The chain as the policy sees it: both wallets run the passkey wallet wasm.
const lookupWasm = async (id: string) => (id === WALLET || id === OTHER_WALLET ? SMART_ACCOUNT.accountWasmHash : null);
const verdict = (func: xdr.HostFunction, signer = WALLET) => checkPayload(payload(func, signer), CARACAL_POLICY, lookupWasm);

describe("adversary s2: which split deployments the relay sponsors", () => {
  it("control: the page's own deployment (SPLIT_SALT, owner = the signing wallet) is sponsored and lands at splitAddressFor(wallet)", async () => {
    const func = deploySplitFunction(WALLET, 1000, 1500);
    expect((await verdict(func)).ok).toBe(true);
    const pre = func.createContractV2().contractIdPreimage().fromAddress();
    expect(contractAddressFrom(WALLET, Buffer.from(pre.salt()))).toBe(splitAddressFor(WALLET));
  });

  it("a second split for the same wallet (another salt) is not sponsored: one split contract per user", async () => {
    const other = Buffer.from(hash(Buffer.from("caracal-split-v2")));
    expect(other.equals(SPLIT_SALT)).toBe(false);
    const func = deployFrom(WALLET, other, WALLET);
    // It lands at an address the page never shows, so it is a second, unlisted split for this wallet.
    expect(contractAddressFrom(WALLET, other)).not.toBe(splitAddressFor(WALLET));
    const v = await verdict(func);
    // Defect: ok is true, so the sponsor pays for as many extra splits as a wallet asks for.
    expect(v.ok, JSON.stringify(v)).toBe(false);
  });

  it("a split deployed by one wallet for another wallet as owner is not sponsored", async () => {
    // WALLET signs a deployment at ITS split address whose constructor makes OTHER_WALLET the owner.
    const func = deployFrom(WALLET, SPLIT_SALT, OTHER_WALLET);
    expect(contractAddressFrom(WALLET, SPLIT_SALT)).toBe(splitAddressFor(WALLET));
    const v = await verdict(func);
    // Defect: ok is true. The contract now sits at WALLET's own split address with a different owner,
    // which the page refuses ("not owned by your wallet") and can never replace.
    expect(v.ok, JSON.stringify(v)).toBe(false);
  });
});
