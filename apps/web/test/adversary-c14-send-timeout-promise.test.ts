// Adversary c14: the page promises "this page offers to start another cash-out" after a send that
// timed out (the kit's signAndSubmit never answers within SEND_TIMEOUT_MS), and never does.
//
// Spec: goal 5 (a control the page says it will offer, never offered) and docs/decisions.md 2026-11-27
// c13 row: "90 s after it settled, with the anchor still waiting, the page says the payment can no longer
// reach the network ... and offers 'Start another cash-out'", and the c3 row: past the 5 minute limit
// "the outcome is unknown ... and the anchor's status decides".
// Cause: src/app/cashout/page.tsx sets sendSettledAt only in the `.finally` of kit.signAndSubmit. When that
// call never settles (the kit's confirmation poll runs on an RPC client with no timeout, see the SEND_TIMEOUT_MS
// comment in src/lib/anchor/flow.ts), sendToAnchor gives up at 5 minutes with "unknown", but sendSettledAt
// stays null, so LAND_WINDOW_MS never starts, `landingOver` never becomes true, and the text "this page
// offers to start another cash-out" stays on screen for ever with no such control.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit (a signAndSubmit
// that never answers, which is the case SEND_TIMEOUT_MS exists for).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c14: a send that timed out keeps the promise of a way forward", () => {
  it("control: a send that settles (relay did not answer) offers 'Start another cash-out' two minutes later", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: false, error: { code: 5003, message: "Relayer request failed with status 502" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    await tick(120_000);
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    rt.unmount();
  });

  it("a send that never answers: after the 5 minute limit and the landing window the page offers 'Start another cash-out' as it said it would", async () => {
    const { rt, world } = await mount({ submit: () => new Promise(() => {}) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    await tick(5 * 60_000 + 1_000);
    expect(text(rt)).toContain("Caracal got no answer about the USDC payment within 5 minutes"); // unknown, as designed (the harness works)
    const promise = "this page offers to start another cash-out";
    expect(text(rt)).toContain(promise); // the promise is made
    await tick(10 * 60_000); // far longer than any payment can still land
    expect(text(rt)).toContain("The anchor is waiting for your USDC."); // the anchor never moves on
    // Either the control arrives or the promise is withdrawn; both leave the person told the truth.
    expect(!text(rt).includes(promise) || buttonLabels(rt.tree).includes("Start another cash-out")).toBe(true);
    rt.unmount();
  });
});
