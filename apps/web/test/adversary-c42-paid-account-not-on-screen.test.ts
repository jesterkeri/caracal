// Adversary c42 #1: Send pays the account the person first saw, while the confirm screen shows a different one.
//
// Spec: docs/decisions.md 2026-11-27 c5 ("Send compares the anchor's latest account and memo with those on screen when
// the person reached the confirm step ... refuses on a change, and pays the latest record only after the person
// confirms again") and c11 ("What the person saw now includes the quote; any change refuses Send once"), and
// src/app/cashout/page.tsx payTo(): "What the person confirms on the confirm screen ... Send is refused when any of it
// changed after it was shown". Goal 1: a payment goes to an address other than the one the person confirmed.
// Cause: the page keeps the record the person is shown in `txn` (the poll rewrites it every 3 s), but Send compares the
// anchor's latest answer only with seenRef, the account and memo of the FIRST record shown on reaching the confirm
// step, which the poll never updates. When the poll has put a changed account on screen and the anchor's next answers
// (the press, then the check before the passkey) show the first account again (a lagging replica, a cache, a flapping
// record), Send matches seenRef and signs a payment to the first account, although the screen the person pressed Send
// on shows the second.
//
// Assertion: after the screen shows account B, a Send pressed while the anchor answers A again must not sign a payment
// (A is not what the person is looking at). Passes for any fix that also compares with the record on screen at the
// press. The controls (nothing changes; B stays) behave correctly today.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor (fetch stub), kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

// The fixture's account (the one the first confirm screen shows) and another valid classic account.
const OTHER_ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("adversary c42: the payment goes to an account that is not on the confirm screen", () => {
  it("control: nothing changes, so the payment is signed for the account on screen", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(500);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("control: the anchor changes the account, the screen shows it and stays so, and Send is refused once", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    const first = String(world.txn.withdraw_anchor_account);
    world.txn.withdraw_anchor_account = OTHER_ACCOUNT;
    await tick(3100); // the poll puts the new account on screen
    expect(text(rt)).toContain(OTHER_ACCOUNT);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(500);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    expect(first).not.toBe(OTHER_ACCOUNT);
    rt.unmount();
  });

  it("the screen shows account B, the anchor answers A again at the press: no payment is signed", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    const first = String(world.txn.withdraw_anchor_account);
    world.txn.withdraw_anchor_account = OTHER_ACCOUNT;
    await tick(3100); // the poll puts account B on screen
    expect(text(rt)).toContain(OTHER_ACCOUNT);
    expect(text(rt)).not.toContain(first); // the person is looking at B only
    world.txn.withdraw_anchor_account = first; // the next answers (a stale replica, a cache) show A again
    void clickButton(rt.tree, /Send 2 USDC/); // pressed on the screen that shows B
    await tick(500);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
