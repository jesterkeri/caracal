// Adversary c20: the page's own USDC payment is confirmed on chain (its hash is shown), but the anchor's
// record stays at pending_user_transfer_start (the anchor has not matched the payment: a memo or muxed-id
// mismatch, a watcher that is down). The page then says only "The anchor is waiting for your USDC." under
// the hash of the payment that already left the wallet, never says the payment was sent, never says not
// to send again, offers no control, and keeps polling for ever: the person is told the opposite of what
// the page knows and has no way forward. The spike (docs/research/anchor-spike-2026-11-27.md section 6)
// never ran the fee-relay path with a muxed destination, so "paid, anchor did not register it" is a state
// the page must handle.
//
// Spec: goals 4 and 5 (told something false; left stuck with no way forward) and docs/decisions.md
// 2026-11-27 rows: c12 ("statusText now knows whether this page holds a sent payment's hash and then says
// the payment was sent and to ask the anchor for a refund") and c13 ("if the payment never landed the
// anchor stays at pending_user_transfer_start and the page had no way forward"): the same dead end, for a
// payment that did land. c14 gave every unknown send the way forward; a confirmed send that the anchor
// never registers has none.
// Cause: src/lib/anchor/sep24.ts statusText: `case "pending_user_transfer_start"` ignores its `sent`
// argument; src/app/cashout/page.tsx offers no control and no advice for phase "watching" with
// sendConfirmed and a status that never moves (canStartAnother needs done, a lost session or an unknown send).
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit (a confirmed send), popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, find, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const HASH = "cb".repeat(32);

describe("adversary c20: a confirmed USDC payment that the anchor has not registered", () => {
  it("control: the page shows the confirmed payment's hash and reads the anchor's status as it moves", async () => {
    const { rt, world } = await mount({});
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(text(rt)).toContain(`USDC payment on Stellar: ${HASH}`);
    world.txn.status = "pending_anchor"; // the anchor registers the payment
    await tick(3100);
    expect(text(rt)).toContain("The anchor received your USDC");
    rt.unmount();
  });

  it("the anchor still waits: the page does not tell the person the anchor is waiting for USDC that already left", async () => {
    const { rt, world } = await mount({});
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    await tick(3100);
    expect(world.txn.status).toBe("pending_user_transfer_start"); // the anchor has not matched the payment
    expect(text(rt)).toContain(`USDC payment on Stellar: ${HASH}`); // the page holds a confirmed payment
    expect(text(rt)).not.toContain("The anchor is waiting for your USDC");
    rt.unmount();
  });

  it("the anchor never registers it: after 30 minutes the person is told what to do, or has a control", async () => {
    const { rt, world } = await mount({});
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    await tick(30 * 60_000);
    expect(world.txn.status).toBe("pending_user_transfer_start");
    const advice = /ask the anchor|contact the anchor|check with the anchor|do not send (it )?again/i.test(text(rt));
    const control = buttonLabels(rt.tree).length > 0 || find(rt.tree, (e) => e.type === "a" && e.props?.href !== undefined && !String(e.props.href).includes("stellar.expert")).length > 0;
    expect(advice || control).toBe(true);
    rt.unmount();
  });
});
