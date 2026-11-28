// Adversary c36 #1: Send pays the anchor's record while the page cannot read the anchor's status.
//
// Spec: src/app/cashout/page.tsx header of payTo ("Send is refused when any of it changed after it was
// shown", c5 for the account and memo, c11 for the quote) and docs/decisions.md 2026-11-27 c13 row: after the
// anchor refused the session the page "can no longer see its latest terms and does not offer to pay it", because
// both promises need the anchor's current record. Goal 1: a payment to an account or memo other than the one the
// anchor asks for. c13 closed this only for a 401 or 403; any other failure of the status read (5xx, a timeout,
// a lost connection) leaves the poll retrying and Send enabled over the last record it managed to read.
// Cause: src/app/cashout/page.tsx send() pays `txnRef.current ?? txn` and stillCurrent() compares with the same
// ref; only `lostSession` (pollNote starting "The anchor no longer accepts") blocks it, a failing poll does not.
//
// The assertion is unconditional on how it is fixed: with the anchor's account changed and its status endpoint
// unreadable, no USDC payment may be signed. A fix that re-reads the record at the press passes too (the re-read
// fails here, or sees the change); only paying the stale record fails.
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

// A different valid classic account, as the anchor might switch to (the fixture's own ends ...WOA7BXVQF).
const OTHER_ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("adversary c36: Send while the anchor's status cannot be read", () => {
  it("control: with a readable status, a changed account is refused and nothing is signed", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    world.txn.withdraw_anchor_account = OTHER_ACCOUNT;
    await tick(3100); // the poll lands and the screen follows the anchor
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });

  it("with the status read failing (HTTP 503) and the account changed meanwhile, no payment is signed", async () => {
    let code = 200;
    const { rt, world } = await mount({ txnStatusCode: () => code });
    await toConfirm(rt, world);
    code = 503; // the anchor's status endpoint starts failing; the page keeps retrying
    world.txn.withdraw_anchor_account = OTHER_ACCOUNT; // and the anchor changes the account it expects
    await tick(10 * 60_000); // ten minutes of failed polls
    expect(text(rt)).toMatch(/status answered with an error \(503\)/); // the page knows it cannot read it
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
