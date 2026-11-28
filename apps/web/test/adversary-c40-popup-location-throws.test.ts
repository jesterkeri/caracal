// Adversary c40 #1: a pop-up handle whose navigation throws sends the page back to the preview, every time, with the
// anchor's form never offered.
//
// Spec: the pass brief's goals 4 and 5 (a hold or disabled state the person can never get past; the popup closed,
// blocked or throwing as odd but possible input), and docs/decisions.md 2026-11-28 adversary c36 (3) and c37 (1):
// a pop-up the browser will not give or will not close "ends in the form's link". src/app/cashout/page.tsx
// start() already turns a throwing window.open and a throwing opener assignment into "blocked" (the page goes on
// to the form phase, whose "Open the anchor's form" link is the way forward).
// Cause: start() then reads popupRef.current.closed and assigns popupRef.current.location.href (line 358) inside
// the try block whose catch (line 363) closes the pop-up, says "Something went wrong starting the cash-out", and
// goes back to the preview. A stand-in window whose location cannot be assigned (a sandboxed frame, an in-app
// browser, a window the browser severed from this page) throws there AFTER the anchor accepted the sign-in and
// started the withdrawal. The page forgets that withdrawal, never shows its form link, and the next Continue ends
// the same way (another passkey sign-in, another orphaned withdrawal at the anchor): the person can never cash out
// from that browser, though the page has a designed way on for a blocked pop-up.
//
// Assertion: after the anchor started the withdrawal and the pop-up cannot be navigated, the page is in its form
// phase with the anchor's form link (as for a blocked pop-up). Passes for any fix that treats a throwing
// navigation as a blocked pop-up. The control (a pop-up that navigates) passes today.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit, and the pop-up handle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORM_HREF, find, mount, text, tick, clickButton, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** A pop-up handle whose `location.href` cannot be assigned, or whose `closed` cannot be read (or works, as the control). */
function popup(locationThrows: boolean, closedThrows = false) {
  const handle = {
    closed: false,
    close() {
      this.closed = true;
    },
    location: {} as { href: string },
  };
  if (closedThrows) {
    Object.defineProperty(handle, "closed", {
      get: () => {
        throw new DOMException("Blocked a frame from accessing a cross-origin frame", "SecurityError");
      },
    });
  }
  Object.defineProperty(handle.location, "href", {
    get: () => "about:blank",
    set: () => {
      if (locationThrows) throw new DOMException("Blocked a frame from accessing a cross-origin frame", "SecurityError");
    },
  });
  return handle;
}

async function continueToAnchor(locationThrows: boolean, closedThrows = false) {
  const { rt, world } = await mount({ popup: popup(locationThrows, closedThrows) as never });
  await tick(50);
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  const rejected: unknown[] = [];
  Promise.resolve(clickButton(rt.tree, /Continue to the anchor/)).catch((e: unknown) => rejected.push(e));
  await tick(2_000);
  return { rt, world, rejected };
}

describe("adversary c40: a pop-up that cannot be navigated", () => {
  it("control: a pop-up that navigates reaches the form phase with the form link", async () => {
    const { rt, world } = await continueToAnchor(false);
    expect(text(rt)).toContain("Finish the anchor's form in the pop-up window");
    expect(world.popup.location.href).toBe("about:blank"); // the setter of the control does nothing but not throw
    expect(text(rt)).toContain(`href:${FORM_HREF}`);
    rt.unmount();
  });

  it("a pop-up whose navigation throws still ends in the form phase with the anchor's form link", async () => {
    const { rt, world, rejected } = await continueToAnchor(true);
    // The anchor was asked to start the withdrawal and did: the page must not behave as if it never happened.
    expect(world.fetchLog.some((l) => l.includes("/withdraw/interactive"))).toBe(true);
    expect(rejected).toEqual([]);
    expect(text(rt), "the page went back to the preview and shows no form link").toContain(`href:${FORM_HREF}`);
    expect(text(rt)).not.toContain("Something went wrong starting the cash-out");
    rt.unmount();
  });

  it("a pop-up whose closed flag cannot be read still ends in the form phase with the anchor's form link", async () => {
    const { rt, world, rejected } = await continueToAnchor(false, true);
    expect(world.fetchLog.some((l) => l.includes("/withdraw/interactive"))).toBe(true);
    expect(rejected).toEqual([]);
    expect(text(rt), "the page went back to the preview and shows no form link").toContain(`href:${FORM_HREF}`);
    rt.unmount();
  });
});
