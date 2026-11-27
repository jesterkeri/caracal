// Adversary c11: the anchor changes its QUOTE (fee and what arrives) after the confirm screen showed
// it, and one click on Send still pays under the new quote.
//
// Spec: src/app/cashout/page.tsx tells the person "Nothing is sent from your wallet until you confirm
// the anchor's quote here." The quote on the confirm screen is the amount, "Anchor fee" and "Arrives".
// docs/decisions.md 2026-11-27 (c5 row): the page follows the anchor's record on every poll, so a swap
// is silent, and Send is therefore "refused if the anchor's record changed [what the screen showed]
// after the page showed them". Goal 1 (USDC leaves under terms the person did not confirm).
// Cause: src/app/cashout/page.tsx send() compares only payTo(latest) (account, memo type, memo) with
// seenRef. The fee (fee_details.total, its asset) and amount_out are not part of what was "seen", so
// a record that keeps amount_in, account and memo but moves the fee from 0.2 to 1.9 USDC (amount_out
// 1.8 -> 0.1) passes every check, and paymentFor() (src/lib/anchor/transfer.ts) only compares
// amount_in with the confirmed amount.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured
// fixture with the fee edited), kit, Supabase, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttons, clickButton, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c11: the anchor's quote changes after the person looked at it", () => {
  it("control: an unchanged quote is paid once", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain("0.2");
    expect(text(rt)).toContain("1.8 (simulated)");
    await tick(3100);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("the harness shows the new quote on screen (the page follows the anchor's record)", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    world.txn.fee_details = { total: "1.9", asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
    world.txn.amount_out = "0.1";
    await tick(3100);
    expect(text(rt)).toContain("0.1 (simulated)");
    expect(text(rt)).not.toContain("1.8 (simulated)");
    rt.unmount();
  });

  it("a fee raised from 0.2 to 1.9 after the confirm screen showed 0.2 is refused on the next Send", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain("1.8 (simulated)"); // the person looks at this quote
    world.txn.fee_details = { total: "1.9", asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
    world.txn.amount_out = "0.1"; // same amount_in, same account, same memo
    await tick(3100); // the poll lands; the screen is rewritten with no warning
    const send = buttons(rt.tree).find((b) => /^Send/.test(label(b)) && !b.props?.disabled);
    if (send) {
      void send.props!.onClick!(); // the click the person was about to make
      await tick(50);
    }
    // The commitment: refused, as for a swapped account. Today the USDC is signed and submitted.
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
