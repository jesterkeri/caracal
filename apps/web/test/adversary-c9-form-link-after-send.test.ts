// Adversary c9: after the USDC was sent, the page tells the person to open the anchor's form and offers no way to.
//
// Spec: src/lib/anchor/sep24.ts statusText() for pending_user and pending_trust: "The anchor needs something
// more from you. Open its form from the anchor's page to see what." And goal 5 (a control offered that cannot
// work, no way forward); docs/decisions.md 2026-11-27 (Cash-out fixes (3)): "Open the anchor's form" is
// offered during the form phase, and the c8 row: the form step is shown "only while the anchor can still
// finish it" (these two statuses are not final).
// Cause: src/app/cashout/page.tsx renders the "Open the anchor's form" link only in phase "form"
// (`phase === "form" && session && !done && !lostSession`). Once Send has been pressed the phase is
// "watching": statusText() is shown, but the link, the session's url (still in memory) and every other control
// are gone, and "Start another cash-out" waits for a final status that a withdrawal stuck on pending_user may
// never reach. The person is told to open a form the page does not offer, with nothing else to press.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured record
// with its status changed), kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORM_HREF, buttonLabels, clickButton, mount, text, tick, toConfirm, pressContinue, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** The person's way to the anchor's form: the link or a button that opens it. */
const offersForm = (rt: { tree: unknown }) => text(rt as never).includes(`href:${FORM_HREF}`) || buttonLabels(rt.tree).some((l) => /open.*form/i.test(l));

describe("adversary c9: the anchor asks for more from the person after the payment was sent", () => {
  it("control: during the form step the page offers the anchor's form", async () => {
    const { rt } = await mount();
    await pressContinue(rt);
    await tick(3100);
    expect(text(rt)).toContain("Finish the anchor's form in the pop-up window");
    expect(offersForm(rt)).toBe(true);
    rt.unmount();
  });

  for (const status of ["pending_user", "pending_trust"]) {
    it(`the anchor says "${status}" after the payment was sent: the page that says to open its form offers it`, async () => {
      const { rt, world } = await mount();
      await toConfirm(rt, world);
      void clickButton(rt.tree, /Send 2 USDC/);
      await tick(50);
      world.txn.status = status;
      await tick(3100);
      // the harness works: the payment went, and the page shows the anchor's request
      expect(text(rt)).toContain("USDC payment on Stellar");
      expect(text(rt)).toContain("Open its form from the anchor's page to see what.");
      expect(offersForm(rt)).toBe(true); // today: no link, no button; the only control would need a final status
      rt.unmount();
    });
  }
});
