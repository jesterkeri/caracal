// Adversary c33: Send is refused because another tab of this browser still holds the wallet's payment lock, and
// the page shows the person nothing: no message, and Send stays enabled, so every press is silently dropped.
//
// How it happens: tab A sent a payment whose outcome is unknown. The network has passed its closeBy, but tab A's
// kit call has not settled and tab A cannot read a ledger (offline, a stuck RPC), so it never runs passLedger and
// keeps the Web Lock (send-guard.ts passLedger, holdsSendLock). Tab B reads a ledger past the record's closeBy,
// so its own check, sendHold(wallet, ledger), says the hold has lifted, and Send is offered. B presses Send:
// acquireSend (send-guard.ts lockAndBegin) is refused the lock, answers with hold text because "!lock", and the
// page's send() calls refuseHeld(begun.hold), which remembers the text as `heldText` and sets it as the problem.
// But the page shows a remembered hold text only while hold.held (page.tsx `heldGone = problem === heldText &&
// !hold.held`), and hold.held is false (the ledger is past closeBy), so shownProblem is null. Send goes back to
// "confirm" with nothing said, and the next press does the same, for as long as tab A holds the lock.
//
// Spec: docs/decisions.md 2026-11-28 c31 row (a remembered hold text goes only "once the network has passed" the
// payment, because the refusal no longer applies); here the refusal DOES still apply (the lock is held), so it
// must still be shown. Attacker goal 5: a failure not shown, no way forward. send-guard.ts header: "no cash-out
// of this wallet starts or sends while the record says it can still land"; the lock is the second, atomic half
// of that check. No money moves (the guard refuses); the harm is a press with no answer.
//
// The test passes for any fix that either says why Send did nothing, or does not offer Send while the lock is
// held. Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime; the other tab's lock is held
// through the test setup's navigator.locks (test/setup-web-locks.ts). Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, clickButton, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const KEY = `caracal.cashout.send.${WALLET}`;
const sendButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Send 2 USDC/.test(label(b)));
/** Tab A: holds the wallet's payment lock for good, as a payment whose kit call never settles does. */
function otherTabHoldsLock() {
  const locks = (globalThis.navigator as unknown as { locks: { request(n: string, o: { ifAvailable: true }, cb: (l: unknown) => Promise<unknown>): Promise<unknown> } }).locks;
  void locks.request(KEY, { ifAvailable: true }, () => new Promise(() => {}));
}

describe("adversary c33: a refused Send says nothing while another tab holds the payment lock", () => {
  it("control: with the lock held and the record still within closeBy, the refusal is shown", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    store.set(KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 140, anchorId: "other-withdrawal-id", hash: null }));
    otherTabHoldsLock();
    await tick(3100);
    // The hold is held, so Send is not offered enabled and the hold text is on screen.
    const send = sendButton(rt);
    expect(send === undefined || send.props?.disabled === true).toBe(true);
    expect(text(rt)).toMatch(/earlier USDC payment/);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });

  it("control: with no other tab, Send pays once", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("control: past closeBy and no lock held, Send is offered and pays once", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    store.set(KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 101, anchorId: "other-withdrawal-id", hash: null }));
    await tick(12_000);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(200);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("past closeBy but the other tab still holds the lock: a press is answered (message, or no Send offered)", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    // Harness ledger is about 100 + 3 s/5 s; closeBy 101 is passed within a few polls.
    store.set(KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 101, anchorId: "other-withdrawal-id", hash: null }));
    otherTabHoldsLock();
    await tick(12_000); // the hold poll reads a ledger past closeBy: sendHold says the hold has lifted
    const before = text(rt);
    const send = sendButton(rt);
    if (send !== undefined && send.props?.disabled !== true) {
      void (send.props!.onClick as () => unknown)();
      await tick(200);
      const after = text(rt);
      // Observed on 6cc5dbc: Send is enabled, the press goes back to the confirm screen, and no sentence says why
      // nothing was sent: the refusal's text is remembered as a hold text and hidden because the record's closeBy
      // has passed, although the lock refusal still applies.
      expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
      expect(after, `the press changed nothing on screen; the person sees: ${after.slice(-200)}`).not.toBe(before);
    }
    rt.unmount();
  });
});
