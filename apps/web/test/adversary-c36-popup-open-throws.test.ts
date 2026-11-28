// Adversary c36 #3: a browser whose window.open throws (instead of returning null) leaves the page busy for ever.
//
// Spec: goals 4 and 5 (a page that sticks busy; the popup blocked) and src/app/cashout/page.tsx start(): "The
// popup is opened now, inside the click ... Your browser blocked the pop-up" is the designed outcome of a refused
// pop-up (popupNote "blocked", the form's link shown). Some embedded browsers and sandboxed frames raise a
// SecurityError from window.open rather than returning null.
// Cause: src/app/cashout/page.tsx start() sets phase "starting" and then calls window.open outside its try block, so
// a throw rejects start() after "Signing in to the anchor with your passkey..." is on screen: nothing signs in,
// nothing is cleared, no control is shown, and the click handler rejects unhandled. Only a reload ends it.
//
// Assertion: after a throwing window.open the page is not left on the sign-in text with no control: it either
// carries on (the blocked-pop-up path) or goes back to the preview with Continue offered again.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit, popup (a window.open that
// throws, and one that returns null as the control).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, find, mount, text, tick, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const SIGNING_IN = "Signing in to the anchor with your passkey";

async function pressContinueWith(open: () => unknown) {
  const { rt, world } = await mount();
  await tick(50);
  (globalThis as unknown as { window: { open: () => unknown } }).window.open = open;
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  const rejected: unknown[] = [];
  Promise.resolve(clickButton(rt.tree, /Continue to the anchor/)).catch((e: unknown) => rejected.push(e));
  await tick(2_000);
  return { rt, world, rejected };
}

describe("adversary c36: window.open that throws", () => {
  it("control: a refused pop-up (null) carries on to the anchor's form with the blocked note", async () => {
    const { rt } = await pressContinueWith(() => null);
    expect(text(rt)).toContain("Your browser blocked the pop-up");
    expect(text(rt)).not.toContain(SIGNING_IN);
    rt.unmount();
  });

  it("a window.open that throws does not leave the page on the sign-in text with no way forward", async () => {
    const { rt, rejected } = await pressContinueWith(() => {
      throw new DOMException("The pop-up could not be opened", "SecurityError");
    });
    const stuck = text(rt).includes(SIGNING_IN) && !buttonLabels(rt.tree).some((l) => /Continue to the anchor|Start/.test(l));
    expect(stuck, "the page still says it is signing in, with no control").toBe(false);
    expect(rejected, "the click handler rejected unhandled").toEqual([]);
    rt.unmount();
  });
});
