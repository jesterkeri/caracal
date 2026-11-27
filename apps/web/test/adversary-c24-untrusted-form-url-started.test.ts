// Adversary c24: the anchor started the withdrawal but gave a form address Caracal refuses, and the page says
// "Nothing was started".
//
// Spec: goal 4 (a person is told something false), and the page's own standard for this step: docs/decisions.md
// 2026-11-27 c1 row ("a timed-out withdraw start says the anchor may have started it") and src/lib/anchor/sep24.ts
// startWithdraw, whose other branches say what is true ("The anchor may have started it. No USDC has been sent").
// Cause: src/lib/anchor/sep24.ts startWithdraw returns checkInteractiveUrl(o.url) AFTER the anchor answered with a
// transaction id, and checkInteractiveUrl throws "...so it was not opened. Nothing was started." The anchor did
// start it: POST /transactions/withdraw/interactive was answered 200 with an id, so a withdrawal record exists at
// the anchor (status incomplete) that the page then abandons. No USDC moves, so this is wrong wording about the
// anchor's state, not lost money.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit, Supabase, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ID, FORM_URL, mount, pressContinue, text, tick, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** Continue pressed while the anchor answers the withdraw start with `url` as the form address. */
async function startWith(url: string) {
  const { rt, world } = await mount();
  const harnessFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes("/withdraw/interactive")) return harnessFetch(input, init);
    world.fetchLog.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify({ id: ID, url }));
  });
  await pressContinue(rt);
  await tick(100);
  return { rt, world };
}

describe("adversary c24: a withdrawal the anchor started is not 'nothing started'", () => {
  it("control: a trusted form address opens the form (the anchor's withdraw start was answered once)", async () => {
    const { rt, world } = await startWith(FORM_URL);
    expect(world.popup.location.href).toContain("anchor-ref-ui-testanchor.stellar.org");
    expect(text(rt)).toContain("Finish the anchor's form");
    rt.unmount();
  });

  it("an untrusted form address is refused, but the page must not say nothing was started", async () => {
    const { rt, world } = await startWith("https://evil.example/form");
    // the harness did what the scenario says: the anchor was asked, answered with an id, and the page refused the address
    expect(world.fetchLog.filter((l) => l.startsWith("POST") && l.includes("/withdraw/interactive"))).toHaveLength(1);
    expect(text(rt)).toContain("does not trust"); // refused, nothing opened
    expect(world.popup.location.href).toBe("");
    // today: "... so it was not opened. Nothing was started." although the anchor holds the withdrawal it started
    expect(text(rt)).not.toMatch(/Nothing was started/);
    rt.unmount();
  });
});
