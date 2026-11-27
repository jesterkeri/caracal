// Adversary c2: the anchor's form window keeps a handle on the Caracal page.
//
// src/app/cashout/page.tsx start() opens the popup with window.open("", "caracal-anchor",
// "popup,width=480,height=760") and later sets popup.location.href to the anchor's form. A browser
// popup opened that way (no "noopener") has window.opener pointing at the Caracal page, and keeps
// it after navigating to the cross-origin form. The form is third-party content on a stellar.org
// host (the page trusts any *.stellar.org address, config.ts INTERACTIVE_HOST_SUFFIX), and a page in
// it can navigate window.opener to any address (reverse tabnabbing: the Caracal tab turns into a
// phishing page). The page's own "Open the anchor's form" link does set rel="noopener noreferrer",
// so the intent is clear; the popup path misses it. Goal 2: a page that is not the anchor's opened
// where the person is signed in to their wallet.
//
// The fake popup models what a browser does: opener is the opening window until it is set to null.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { find, mount, pressContinue, tick, unmock, FORM_HREF } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const browserPopup = () => ({
  closed: false,
  close() {
    this.closed = true;
  },
  location: { href: "" },
  opener: "the Caracal page" as unknown,
});

describe("adversary c2: the popup's window.opener", () => {
  it("control: the page opens the anchor's form in the popup and the link is rel=noopener", async () => {
    const popup = browserPopup();
    const { rt, world } = await mount({ popup });
    await pressContinue(rt);
    await tick(50);
    expect(popup.location.href).toBe(FORM_HREF);
    expect(world.opened).toBe(1);
    const link = find(rt.tree, (e) => (e as { type?: unknown }).type === "a" && String((e as { props?: { href?: string } }).props?.href).startsWith("https://anchor-ref-ui"))[0] as { props: { rel?: string } };
    expect(link.props.rel).toMatch(/noopener/);
    rt.unmount();
  });

  it("the popup showing the anchor's form cannot reach back to the Caracal page", async () => {
    const popup = browserPopup();
    const { rt, world } = await mount({ popup });
    await pressContinue(rt);
    await tick(50);
    expect(popup.location.href).toBe(FORM_HREF); // it has been pointed at the third-party form
    const features = String(world.openArgs[0]?.[2] ?? "");
    const severed = popup.opener === null || /noopener/.test(features);
    expect(severed).toBe(true);
    rt.unmount();
  });
});
