// Adversary i5. Promise (lib/invoices/errors.ts doc comment on splitErrorText): "The same number means different
// things in different contracts, so an error is read as the split's only when the text says the split raised it
// (or does not say which contract); the USDC contract's 'insufficient balance' (#10) is named as that."
// Goal 4 (a person is told a wrong cause).
//
// A simulation error from the RPC begins with a bare "HostError: Error(Contract, #N)" line that names no
// contract (the shape the repo's own fixtures use: invoice-chain.test.ts, adversary-i2-relay-refusal-unknown),
// and the diagnostic events follow, each naming the contract that raised it. splitErrorText takes the FIRST line
// that carries an error number. That is the bare line, which "does not say which contract", so it is read as the
// split's. A payment that fails because the USDC contract refused the transfer (#10, insufficient balance)
// is therefore shown as the split's #10: "This invoice does not exist on chain." The payer is told the invoice
// is missing when the wallet is short of USDC (the balance can change between the page's balance read and the
// call's simulation, so this path is reachable).
import { contract } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { payInvoice } from "../src/lib/invoices/chain";
import { splitErrorText } from "../src/lib/invoices/errors";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";

afterEach(() => vi.restoreAllMocks());

// The RPC's rendering: a bare HostError line, then the event log naming the contract that raised the error.
const usdcRefusal = (n: number) =>
  `HostError: Error(Contract, #${n})\n\nEvent log (newest first):\n 0: [Diagnostic Event] contract:${TOKENS.usdc}, topics:[error, Error(Contract, #${n})], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"`;

describe("an error number raised by the USDC contract is not read as the split's", () => {
  it("control: with only the USDC event line, #10 is named as not enough USDC", () => {
    expect(splitErrorText(`0: [Diagnostic Event] contract:${TOKENS.usdc}, topics:[error, Error(Contract, #10)]`, SPLIT)).toMatch(/does not hold enough USDC/);
  });

  it("the RPC's full text (bare HostError line first) names the USDC contract's #10 as not enough USDC", () => {
    // Fails today: the bare first line wins and #10 is read as the split's "This invoice does not exist on chain."
    expect(splitErrorText(usdcRefusal(10), SPLIT)).toMatch(/does not hold enough USDC/);
  });

  it("a payment whose call the USDC contract refuses is not reported as a missing invoice", async () => {
    vi.spyOn(contract.AssembledTransaction, "build").mockResolvedValue({ simulation: { error: usdcRefusal(10) } } as never);
    const signAndSubmit = vi.fn();
    const out = await payInvoice({ rpc: {}, signAndSubmit } as never, SPLIT, WALLET, BigInt(5), REF);
    expect(out.kind).toBe("not-sent");
    expect(signAndSubmit).not.toHaveBeenCalled();
    expect((out as { message: string }).message).not.toMatch(/does not exist on chain/);
  });
});
