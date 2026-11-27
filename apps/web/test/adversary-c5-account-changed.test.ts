// Adversary c5: the anchor changes the account and memo to pay AFTER the confirm screen showed
// them, and one click on Send still pays the new account.
//
// Spec: docs/decisions.md 2026-11-27 "Cash-out fixes (3)": "The confirm screen shows the account and
// memo to pay, and Send is refused if the anchor's record changed them after the page showed them."
// And goal 1: USDC leaves the wallet to an account or memo the person did not confirm.
// Cause: src/app/cashout/page.tsx send() compares `txnRef.current` (the newest record) with `txn`
// (the state the screen renders). Both are written by the same poll tick (page.tsx lines 125 and 126),
// so after the first re-render they are always equal and the check (lines 196 to 201) cannot fire. The
// screen silently swaps the account under the person, and the next click on "Send 2 USDC to the
// anchor" (a label that names no account) pays the swapped one.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: the anchor (the repo's captured
// fixtures with the account edited), the kit, Supabase, the popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttons, clickButton, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const OTHER_ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ORIGINAL_ACCOUNT = "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF"; // test/fixtures/anchor/txn-pending-user-transfer-start.json

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c5: the anchor changes the account to pay after the person looked at it", () => {
  it("control: an unchanged record is paid once, to the account the screen showed", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain(ORIGINAL_ACCOUNT);
    await tick(3100); // another poll, nothing changed
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("the harness shows the swap on screen (the page follows the anchor's record)", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain(ORIGINAL_ACCOUNT);
    world.txn.withdraw_anchor_account = OTHER_ACCOUNT;
    await tick(3100);
    expect(text(rt)).toContain(OTHER_ACCOUNT);
    expect(text(rt)).not.toContain(ORIGINAL_ACCOUNT);
    rt.unmount();
  });

  it("an account swapped after the confirm screen showed the old one is refused, not paid, on the next Send", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain(ORIGINAL_ACCOUNT); // the person looks at this account
    world.txn.withdraw_anchor_account = OTHER_ACCOUNT; // the anchor's record changes (memo too)
    world.txn.withdraw_memo = "1";
    await tick(3100); // the poll lands; the screen is rewritten with no warning
    const send = buttons(rt.tree).find((b) => /^Send/.test(label(b)) && !b.props?.disabled);
    if (send) {
      void send.props!.onClick!(); // the person clicks the same button they were about to click
      await tick(50);
    }
    // The commitment: refused. Today the USDC payment is signed and submitted to the swapped account.
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
