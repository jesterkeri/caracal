// Adversary c8: the "form" phase of the cash-out page says things that are not true any more.
//
// Spec: goal 4 (a wrong cause) and goal 5 (a control offered that cannot work); docs/decisions.md
// 2026-11-27 rows c2 and c5 ("the anchor's status is the truth", a control the page knows cannot work is
// not offered). Cause, both in src/app/cashout/page.tsx:
// 1. start(): `if (popupRef.current && !popupRef.current.closed) ... else setPopupBlocked(true)` and the
//    form section prints "Your browser blocked the pop-up." whenever popupBlocked is set. A pop-up that
//    opened and that the person closed during the passkey prompt is not a blocked pop-up.
// 2. The form section is shown whenever phase === "form", also after the anchor reported a final status
//    (expired, error, too_small ...): it keeps saying "This page moves on by itself when the anchor is
//    ready for your USDC" and keeps offering "Open the anchor's form", beside the anchor's own
//    "expired" text and "Start another cash-out".
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORM_HREF, mount, pressContinue, text, tick, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c8: the pop-up the person closed", () => {
  it("control: a pop-up that stays open is pointed at the anchor's form and nothing says it was blocked", async () => {
    const { rt, world } = await mount();
    await pressContinue(rt);
    await tick(50);
    expect(world.popup.location.href).toBe(FORM_HREF);
    expect(text(rt)).toContain("Finish the anchor's form in the pop-up window");
    expect(text(rt)).not.toContain("blocked");
    rt.unmount();
  });

  it("a pop-up the person closed while the passkey prompt was open is not reported as blocked by the browser", async () => {
    const { rt, world } = await mount({
      signAuthEntry: async (e) => {
        world.popup.closed = true; // the person closes the blank window
        return e;
      },
    });
    await pressContinue(rt);
    await tick(50);
    // the harness works: the sign-in finished and the page is on the anchor's form step, without a pop-up
    expect(text(rt)).toContain("Finish the anchor's form in the pop-up window");
    expect(world.popup.location.href).toBe("");
    // the defect: the browser blocked nothing, it was opened and then closed by the person
    expect(text(rt)).not.toContain("Your browser blocked the pop-up");
    rt.unmount();
  });
});

describe("adversary c8: the form step after the anchor reported a final status", () => {
  it("control: while the form is still open the page says it moves on by itself and offers the form", async () => {
    const { rt } = await mount();
    await pressContinue(rt);
    await tick(3100);
    expect(text(rt)).toContain("This page moves on by itself when the anchor is ready for your USDC");
    expect(text(rt)).toContain("Open the anchor's form");
    rt.unmount();
  });

  for (const status of ["expired", "error", "too_small"]) {
    it(`the anchor says "${status}" during the form step: the page no longer promises to move on or offers the form`, async () => {
      const { rt, world } = await mount();
      await pressContinue(rt);
      await tick(50);
      world.txn.status = status;
      await tick(3100);
      // the harness works: the page took the anchor's final status in and offers a new cash-out
      expect(text(rt)).toContain("Start another cash-out");
      // the defect: it still promises to move on by itself and offers a form that cannot finish this withdrawal
      expect(text(rt)).not.toContain("moves on by itself");
      expect(text(rt)).not.toContain("Open the anchor's form");
      rt.unmount();
    });
  }
});
