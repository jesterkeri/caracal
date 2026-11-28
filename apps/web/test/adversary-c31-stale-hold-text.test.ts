// Adversary c31: after the send guard refuses a press (Continue or Send) because another tab of the browser holds
// a payment that may still land, the refusal's text is kept in `problem` for ever. The hold lifts on its own
// (the page reads the ledger every 5 s and passes closeBy), Continue and Send work again, but the red box still
// says "no new cash-out can start or send for about N minutes" and "An earlier USDC payment ... may still go
// through". The person is told something false: the page says no cash-out can start while it can.
//
// Cause: src/app/cashout/page.tsx start() line 249 and send() line 326 store the hold's text with
// setProblem(holdText(...)). Nothing clears `problem` when the hold lifts: only start() success, startAgain()
// and a later send outcome call setProblem. The same hold is also shown live from `hold` (line 542, which does
// go away), so the stored copy is the stale one. The page's render only drops it when the person presses
// something that succeeds.
//
// Spec: send-guard.ts header ("no cash-out of this wallet starts or sends while the record says it can still
// land": so after it can no longer land, the page may not say one cannot start) and docs/decisions.md
// 2026-11-28 c27 row (the page must not say what the guard no longer holds: "the page never offers what the hold
// would refuse", and the advice states ledger facts only once read). Attacker goal 4 (a person is told
// something false), and 5 (a page that says there is no way forward).
//
// How the other tab is made: its payment record is written into the browser's storage under the real key with
// the repo's own record shape (send-guard.ts Rec: v 2, id, closeBy, anchorId, hash), closeBy 3 ledgers past the
// fake ledger. No money moves; the anchor, kit and popup are faked as in the c2 harness.
//
// The test passes for any fix that stops showing the refusal once the hold has lifted (clear it, or render the
// hold live instead of storing it) and fails only while the stale sentence stays beside a working Continue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, clickButton, find, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const KEY = `caracal.cashout.send.${WALLET}`;
const STALE = /may still go through|no new cash-out can start or send/;
/** What another tab's unknown payment leaves behind: a record whose closeBy is 3 ledgers (15 s) ahead of the harness's ledger 100. */
const otherTabRecord = () => JSON.stringify({ v: 2, id: "other-tab", closeBy: 103, anchorId: "other-withdrawal-id", hash: null });

const continueButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));

describe("adversary c31: a hold refusal stays on the page after the hold has lifted", () => {
  it("control: while the other tab's payment can still land, the page says so, and the press is refused", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    expect(continueButton(rt)?.props?.disabled).toBe(false); // nothing is held yet
    store.set(KEY, otherTabRecord()); // another tab sent and its outcome is unknown
    void clickButton(rt.tree, /Continue to the anchor/); // this tab's page has not re-rendered, so it still offers Continue
    await tick(10);
    expect(text(rt)).toMatch(STALE);
    expect(world.opened).toBe(0); // refused: no pop-up, no sign-in
    rt.unmount();
  });

  it("control: once the network is past closeBy, Continue is enabled and starts a cash-out", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    store.set(KEY, otherTabRecord());
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(30_000); // ledger 100 + 6: past closeBy 103; the page's own poll has lifted the hold
    expect(continueButton(rt)?.props?.disabled).toBe(false);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(50);
    expect(world.opened).toBe(1); // it works
    rt.unmount();
  });

  it("after the hold lifted and Continue works again, the page does not still say no cash-out can start", async () => {
    const store = new Map<string, string>();
    const { rt } = await mount({ store });
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    store.set(KEY, otherTabRecord());
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(30_000);
    expect(continueButton(rt)?.props?.disabled).toBe(false); // the guard would let a cash-out start now
    // Observed on 0095c65: the red box still reads "An earlier USDC payment ... may still go through ... no new
    // cash-out can start or send for about 1 minute", beside an enabled "Continue to the anchor".
    expect(text(rt)).not.toMatch(STALE);
    rt.unmount();
  });

  it("control: once the network is past that closeBy, the same Send works", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    store.set(KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 118, anchorId: "other-withdrawal-id", hash: null }));
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled(); // refused while held
    await tick(100_000);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1); // the guard let it through
    rt.unmount();
  });

  it("the same for Send: refused by another tab's hold, then the hold lifts, Send works, and the page still says nothing can send", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    store.set(KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 118, anchorId: "other-withdrawal-id", hash: null })); // ledger is about 106 here
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(text(rt)).toMatch(STALE); // refused, as it should be
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    await tick(100_000); // past ledger 118 (ledger 100 + 103 s / 5 s = 120)
    const send = buttons(rt.tree).find((b) => /Send 2 USDC/.test(label(b)));
    expect(send?.props?.disabled).not.toBe(true); // Send is offered
    expect(text(rt)).not.toMatch(STALE); // and the page no longer says that nothing can send
    rt.unmount();
  });
});
