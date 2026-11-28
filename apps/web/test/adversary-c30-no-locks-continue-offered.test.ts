// Adversary c30: on a browser that has no Web Locks (or whose storage cannot be written), the cash-out page
// offers "Continue to the anchor", asks for the passkey, starts a real withdrawal at the anchor and sends the
// person through the anchor's whole form, although Send can never pay: it is refused at the very end.
//
// Cause: src/app/cashout/page.tsx computes `hold` with sendHold(wallet, seenLedger) (the preview's Continue is
// `disabled={!preview?.ok || hold.held}`, and start() checks the same). sendHold (src/lib/anchor/send-guard.ts)
// only reads the stored record, so it says { held: false } when there is none. "unsupported" (no Web Locks) and
// an unwritable store are found only by acquireSend/beginSend, inside send(), after the sign-in, the anchor's
// form and the confirm step.
//
// Spec: send-guard.ts header: "storage that cannot be written, or a browser without Web Locks, refuses to
// send, because nothing would stop a repeat". The page's own rule (docs/decisions.md 2026-11-27 c12/c8 rows):
// a control that Send would refuse is not offered ("The confirm screen now runs paymentFor's own checks and,
// when they refuse, shows the reason ... with no Send"). Goal 5: a control offered that cannot work.
//
// The test passes for any fix that refuses up front (Continue disabled, or start() refusing with the hold's
// text) and fails only when the anchor withdrawal is started in a browser that will refuse to pay it. No money
// is at risk: Send refuses.
//
// Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton, find, mount, pressContinue, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const nav = globalThis.navigator as unknown as { locks?: unknown };
const realLocks = nav.locks;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(nav, "locks", { value: realLocks, configurable: true });
  vi.restoreAllMocks();
  unmock();
});

const started = (fetchLog: string[]) => fetchLog.some((l) => l.includes("/withdraw/interactive"));

describe("adversary c30: Continue is offered where Send can never pay", () => {
  it("control: with Web Locks, Continue starts the withdrawal and Send asks the passkey once", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(started(world.fetchLog)).toBe(true);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("without Web Locks, the page does not start an anchor withdrawal that its Send will refuse", async () => {
    Object.defineProperty(nav, "locks", { value: undefined, configurable: true });
    const { rt, world } = await mount();
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    let reason = "Continue was refused up front";
    try {
      await pressContinue(rt);
      await tick(50);
      world.txn.status = "pending_user_transfer_start";
      await tick(3100);
      try {
        void clickButton(rt.tree, /Send 2 USDC/);
        await tick(50);
        reason = /This browser cannot keep[^.]*\./.exec(text(rt))?.[0] ?? text(rt).slice(-300);
      } catch {
        reason = "no Send offered";
      }
    } catch {
      /* Continue disabled: fine */
    }
    // Observed on 9dbdaaf: the sign-in and the anchor's withdrawal were started, the passkey was asked for the
    // sign-in, and only Send's refusal ("This browser cannot keep two of its tabs from sending the same payment")
    // came, after the anchor's form.
    expect(started(world.fetchLog), `the withdrawal was started; the person then heard: ${reason}`).toBe(false);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });

  it("with a store that refuses the payment record (quota full), the page does not start a withdrawal its Send will refuse", async () => {
    class Refusing extends Map<string, string> {
      override set(k: string, v: string) {
        if (k.startsWith("caracal.cashout.send.")) throw new Error("QuotaExceededError");
        return super.set(k, v);
      }
    }
    const { rt, world } = await mount({ store: new Refusing() });
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    try {
      await pressContinue(rt);
    } catch {
      /* Continue disabled: fine */
    }
    await tick(50);
    expect(started(world.fetchLog), "the anchor withdrawal was started in a browser that cannot record a payment").toBe(false);
    rt.unmount();
  });
});
