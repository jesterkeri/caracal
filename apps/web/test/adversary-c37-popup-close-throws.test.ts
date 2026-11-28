// Adversary c37 #1: a pop-up handle whose close() throws leaves the cash-out page busy or dead.
//
// Spec: the pass brief's goals 4 and 5 (a page that sticks busy, a control the person can never get past, an
// unhandled rejection, with "the popup closed, blocked or throwing" named as an odd but possible input), and
// docs/decisions.md 2026-11-28 adversary c36 (3): "A window.open that throws (a sandboxed frame or in-app browser)
// left the page on 'Signing in to the anchor ...' with no control". c36 guarded window.open and the opener
// assignment; the page calls popupRef.current.close() unguarded in two more places that decide the page's state.
// Cause: src/app/cashout/page.tsx start() catch (line 349) calls popupRef.current?.close() before setProblem and
// setPhase("preview"), so a throw there rejects start() with the phase left at "starting" ("Signing in to the
// anchor with your passkey...", no control). startAgain() (line 490) calls popup.close() as its first statement, so
// a throw there ends the handler before anything is reset: "Start again" does nothing, for ever.
//
// Assertion: a throwing close() does not leave the page on the sign-in text with no control, nor reject the click
// handler, and "Start again" still returns to the preview. Passes for any fix that guards close() the way the page
// already guards window.open and the opener assignment; the controls (a close() that works) pass today.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor (the start answers 400 in the
// first pair), kit, and the pop-up handle (close() throws, or works as the control).
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

const SIGNING_IN = "Signing in to the anchor with your passkey";

/** A pop-up handle: close() throws when `closeThrows()` says so, as some embedded browsers' stand-ins do. */
function popup(closeThrows: () => boolean) {
  return {
    closed: false,
    close() {
      if (closeThrows()) throw new DOMException("The window could not be closed", "SecurityError");
      this.closed = true;
    },
    location: { href: "" },
  };
}

/** Continue, with an anchor that refuses to start the withdrawal (400), so start() ends in its catch block. */
async function continueAgainstRefusingAnchor(closeThrows: () => boolean) {
  const { rt, world } = await mount({ popup: popup(closeThrows) as never });
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, i?: RequestInit) => (String(u).includes("/withdraw/interactive") ? new Response("no", { status: 400 }) : real(u, i))),
  );
  await tick(50);
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  const rejected: unknown[] = [];
  Promise.resolve(clickButton(rt.tree, /Continue to the anchor/)).catch((e: unknown) => rejected.push(e));
  await tick(2_000);
  return { rt, world, rejected };
}

describe("adversary c37: a pop-up whose close() throws", () => {
  it("control: the anchor refusing the start, with a close() that works, returns to the preview with Continue offered", async () => {
    const { rt, rejected } = await continueAgainstRefusingAnchor(() => false);
    expect(text(rt)).not.toContain(SIGNING_IN);
    expect(buttonLabels(rt.tree)).toContain("Continue to the anchor");
    expect(rejected).toEqual([]);
    rt.unmount();
  });

  it("the anchor refusing the start does not leave the page on the sign-in text with no control when close() throws", async () => {
    const { rt, rejected } = await continueAgainstRefusingAnchor(() => true);
    const stuck = text(rt).includes(SIGNING_IN) && !buttonLabels(rt.tree).some((l) => /Continue to the anchor|Start/.test(l));
    expect(stuck, "the page still says it is signing in, with no control").toBe(false);
    expect(rejected, "the click handler rejected unhandled").toEqual([]);
    rt.unmount();
  });

  it("control: Start again on the confirm screen returns to the preview when close() works", async () => {
    const { rt, world } = await mount({ popup: popup(() => false) as never });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("Pay to account");
    clickButton(rt.tree, /Start again/);
    await tick(100);
    expect(text(rt)).not.toContain("Pay to account");
    expect(buttonLabels(rt.tree)).toContain("Continue to the anchor");
    rt.unmount();
  });

  it("Start again on the confirm screen still returns to the preview when close() throws", async () => {
    let throwing = false;
    const { rt, world } = await mount({ popup: popup(() => throwing) as never });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("Pay to account");
    throwing = true;
    try {
      await clickButton(rt.tree, /Start again/);
    } catch {
      // the handler's own throw is part of the defect: the assertions below say what the person sees
    }
    await tick(100);
    expect(text(rt), "the confirm card is still on screen: Start again did nothing").not.toContain("Pay to account");
    expect(buttonLabels(rt.tree)).toContain("Continue to the anchor");
    rt.unmount();
  });
});
