import { readFileSync } from "node:fs";
import { Address, MuxedAccount, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AnchorError } from "../src/lib/anchor/errors";
import { parseTransaction, type AnchorTxn } from "../src/lib/anchor/sep24";
import { paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { checkPayload } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";

const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));
const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
const ANCHOR_G = "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF";
const TWO = BigInt(20_000_000);
const txn = (over: Partial<AnchorTxn>): AnchorTxn => ({ ...waiting, ...over });

describe("what the anchor asked for, checked against what the person confirmed", () => {
  it("is a USDC payment to the anchor's account with the memo id inside a muxed address", () => {
    const p = paymentFor(waiting, TWO);
    expect(p.stroops).toBe(TWO);
    expect(p.destination).toMatch(/^M[A-Z2-7]{68}$/);
    const m = MuxedAccount.fromAddress(p.destination, "0");
    expect(m.baseAccount().accountId()).toBe(ANCHOR_G);
    expect(m.id()).toBe("4845611746035792652");
  });
  it("carries the largest id a memo can hold", () => {
    expect(MuxedAccount.fromAddress(paymentFor(txn({ withdrawMemo: "18446744073709551615" }), TWO).destination, "0").id()).toBe("18446744073709551615");
  });
  const refusals: [string, Partial<AnchorTxn>, RegExp][] = [
    ["a text memo", { withdrawMemoType: "text", withdrawMemo: "hello" }, /memo type a smart wallet cannot send/],
    ["a hash memo", { withdrawMemoType: "hash", withdrawMemo: "a".repeat(64) }, /memo type a smart wallet cannot send/],
    ["no memo type", { withdrawMemoType: null }, /memo type a smart wallet cannot send/],
    ["no memo", { withdrawMemo: null }, /memo type a smart wallet cannot send/],
    ["a memo id over 64 bits", { withdrawMemo: "18446744073709551616" }, /memo type a smart wallet cannot send/],
    ["a negative memo id", { withdrawMemo: "-1" }, /memo type a smart wallet cannot send/],
    ["a smart-contract destination", { withdrawAnchorAccount: WALLET }, /valid account to pay/],
    ["no destination", { withdrawAnchorAccount: null }, /valid account to pay/],
    ["a garbage destination", { withdrawAnchorAccount: "GNOTANACCOUNT" }, /valid account to pay/],
    ["a quote for a different amount", { amountIn: "3" }, /asks for 3 USDC, not the 2 USDC you chose/],
    ["a quote for a smaller amount", { amountIn: "1.9999999" }, /not the 2 USDC you chose/],
    ["no amount", { amountIn: null }, /did not say how much/],
    ["an unreadable amount", { amountIn: "2e1" }, /did not say how much/],
    ["a zero amount", { amountIn: "0" }, /did not say how much/],
    ["a withdrawal not waiting for USDC", { status: "pending_anchor" }, /not asking for USDC right now/],
    ["a withdrawal whose form is still open", { status: "incomplete" }, /not asking for USDC right now/],
  ];
  for (const [name, over, why] of refusals) {
    it(`refuses ${name}`, () => {
      expect(() => paymentFor(txn(over), TWO)).toThrow(why);
      try {
        paymentFor(txn(over), TWO);
      } catch (e) {
        expect(e).toBeInstanceOf(AnchorError);
        expect((e as Error).message).toMatch(/[Nn]othing was sent|not asking/);
      }
    });
  }
  it("accepts the same amount written with trailing zeros (the anchor's completed record says 2.0000000)", () => {
    expect(paymentFor(txn({ amountIn: "2.0000000" }), TWO).stroops).toBe(TWO);
  });
});

describe("the host function the wallet authorises", () => {
  const p = paymentFor(waiting, TWO);
  const fn = transferHostFunction(WALLET, p).invokeContract();
  it("is the USDC token's transfer(wallet, muxed anchor account, amount)", () => {
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(TOKENS.usdc);
    expect(fn.functionName().toString()).toBe("transfer");
    const [from, to, amount] = fn.args();
    expect(Address.fromScAddress(from!.address()).toString()).toBe(WALLET);
    expect(to!.address().switch().name).toBe("scAddressTypeMuxedAccount");
    expect(scValToNative(amount!)).toBe(TWO);
  });
});

// The relay's own policy (src/lib/relay/policy.ts) must sponsor this exact shape.
describe("Caracal's relay policy and the anchor payment", () => {
  const fakeChain: Record<string, string> = { [WALLET]: SMART_ACCOUNT.accountWasmHash };
  const lookup = async (id: string) => fakeChain[id] ?? null;
  const payload = (signer: string) => {
    const call = transferHostFunction(WALLET, paymentFor(waiting, TWO)).invokeContract();
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] }),
    });
    return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(call).toXDR("base64"), auth: [entry.toXDR("base64")] };
  };
  it("sponsors a USDC transfer from a Caracal wallet to a muxed anchor account", async () => {
    expect((await checkPayload(payload(WALLET), CARACAL_POLICY, lookup)).ok).toBe(true);
  });
  it("still refuses it when the sender is not a Caracal wallet", async () => {
    expect(await checkPayload(payload(ANCHOR_G), CARACAL_POLICY, lookup)).toMatchObject({ ok: false });
  });
});
