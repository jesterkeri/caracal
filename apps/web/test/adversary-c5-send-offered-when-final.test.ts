// Adversary c5: the confirm screen keeps an enabled "Send ... USDC to the anchor" button after the
// anchor has said the withdrawal can no longer take a payment (expired, error, completed ...).
//
// Spec: goal 5 (a control offered that cannot work) and docs/decisions.md 2026-11-27 Cash-out fixes (3):
// "A 'may still go through' message is cleared when the anchor reports completed or refunded" and the
// anchor's status is the truth. src/lib/anchor/transfer.ts paymentFor() refuses any status other than
// pending_user_transfer_start ("The anchor is not asking for USDC right now, so nothing was sent"), so
// the button can never work in these states; yet src/app/cashout/page.tsx lines 318 to 334 render it
// for every txn while phase is "confirm", next to the anchor's "The withdrawal expired" text.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttons, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const enabledLabels = (tree: unknown) => buttons(tree).filter((b) => !b.props?.disabled).map(label);

describe("adversary c5: Send is offered although the anchor will not take the payment", () => {
  it("control: while the anchor waits for the USDC, Send is offered", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(enabledLabels(rt.tree).some((l) => /^Send 2 USDC/.test(l))).toBe(true);
    rt.unmount();
  });

  for (const status of ["expired", "error", "completed", "no_market"]) {
    it(`the anchor says "${status}" while the confirm screen is open: no enabled Send button`, async () => {
      const { rt, world } = await mount();
      await toConfirm(rt, world);
      world.txn.status = status;
      await tick(3100);
      // the harness works: the page took the anchor's status in
      expect(text(rt)).toMatch(/expired before it was finished|reported an error|marked the withdrawal complete|could not do this withdrawal/);
      expect(enabledLabels(rt.tree).filter((l) => /^Send/.test(l))).toEqual([]);
      rt.unmount();
    });
  }
});
