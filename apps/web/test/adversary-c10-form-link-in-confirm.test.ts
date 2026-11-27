// Adversary c10: on the confirm screen, the anchor says its withdrawal needs the form again (pending_user,
// pending_trust, incomplete); the page tells the person to open the anchor's form and offers no way to.
//
// Spec: src/lib/anchor/sep24.ts statusText(): "The anchor needs something more from you. Open its form from
// the anchor's page to see what." (pending_user, pending_trust) and "Waiting for you to finish the anchor's
// form." (incomplete). docs/decisions.md 2026-11-27 (c8): the form step is shown "only while the anchor can
// still finish it", and (c9): a shown status that tells the person to open the anchor's form offers the
// session's form link, because the page held the url in memory and otherwise says to open a form it does not
// offer. Goal 5 (a control the text names does not exist).
// Cause: src/app/cashout/page.tsx renders the "Open the anchor's form" link only in phase "form"
// (`phase === "form" && session && !done && !lostSession`) and, since c9, in phase "watching". In phase
// "confirm" the poll keeps writing the anchor's newest record, so a withdrawal that falls back from
// pending_user_transfer_start to one of these statuses shows `The anchor no longer takes a payment ... Open
// its form from the anchor's page to see what. Start again for a new one.` with "Start again" as the only
// control: the form link (session.url, still in memory) is not offered, and the only way on is to abandon the
// anchor's withdrawal, sign in with the passkey again and start a new one.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured record
// with its status changed), kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORM_HREF, buttonLabels, mount, pressContinue, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

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

describe("adversary c10: the anchor's form is asked for on the confirm screen", () => {
  it("control: during the form step the page offers the anchor's form, and the confirm screen shows Send and Start again", async () => {
    const a = await mount();
    await pressContinue(a.rt);
    await tick(3100);
    expect(text(a.rt)).toContain("Finish the anchor's form in the pop-up window");
    expect(offersForm(a.rt)).toBe(true);
    a.rt.unmount();

    unmock();
    vi.useFakeTimers();
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain("Pay to account");
    expect(buttonLabels(rt.tree)).toEqual(expect.arrayContaining([expect.stringMatching(/^Send 2 USDC/), "Start again"]));
    rt.unmount();
  });

  for (const status of ["pending_user", "pending_trust", "incomplete"]) {
    it(`the anchor says "${status}" after the confirm screen opened: the page that tells the person to use its form offers it`, async () => {
      const { rt, world } = await mount();
      await toConfirm(rt, world);
      world.txn.status = status;
      await tick(3100);
      // the harness works: the confirm screen shows the anchor's newest status
      expect(text(rt)).toContain("The anchor no longer takes a payment for this cash-out, and this page sent none.");
      expect(text(rt)).toMatch(/Open its form from the anchor's page to see what\.|Waiting for you to finish the anchor's form\./);
      expect(offersForm(rt)).toBe(true); // today: no link and no button; the only control is "Start again"
      rt.unmount();
    });
  }
});
