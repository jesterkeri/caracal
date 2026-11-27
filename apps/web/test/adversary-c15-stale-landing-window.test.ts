// Adversary c15: a landing window that an EARLIER send attempt already used up is reused for a LATER
// attempt, so a payment that may still land is called "can no longer reach the network" and a second
// cash-out is offered at once.
//
// Spec: goals 1 and 4 (a payment sent twice, a person told something false) and docs/decisions.md
// 2026-11-27 c13 row: "Once the kit's send has settled, a payment can land only while the relay may still
// send it (60 s from receipt) and the transaction it built is valid (25 s) ... 90 s after it settled, with
// the anchor still waiting, the page says the payment can no longer reach the network ... and offers
// 'Start another cash-out'. Before that it says so and how to recover by reloading."
// Cause: src/app/cashout/page.tsx. `sendSettledAt` is set in the `.finally` of every kit.signAndSubmit, and
// the effect on [sendSettledAt] sets `landingOver` true 90 s later, but nothing ever resets `landingOver`
// (only startAgain does) and send() does not clear `sendSettledAt` when a new attempt begins. So a first
// attempt that was properly "not sent" (the person cancelled the passkey, or the relay refused: the lock is
// released and Send is offered again) starts a 90 s clock; if the person presses Send again after that and
// this attempt's outcome is unknown, `pastLanding` is already true at the moment of the unknown answer.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit (the kit's real
// failure shapes: code 4004 for a closed passkey prompt, code 5003 with no hash for a relay that did not answer).
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

const cancelled = { success: false, error: { code: 4004, message: "The passkey prompt was closed" } };
const relayDidNotAnswer = { success: false, error: { code: 5003, message: "Relayer request failed with status 502" } };
const PAST = "can no longer reach the network";

describe("adversary c15: the landing window belongs to the attempt that is unknown", () => {
  it("control: a first attempt that is unknown keeps 'Start another cash-out' away for the 90 s window", async () => {
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed
    expect(text(rt)).not.toContain(PAST);
    expect(buttonLabels(rt.tree)).not.toContain("Start another cash-out");
    await tick(120_000);
    expect(text(rt)).toContain(PAST); // and after the window it is offered
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    rt.unmount();
  });

  it("a cancelled passkey prompt, then (100 s later) a Send whose answer is lost: the new attempt gets its own window", async () => {
    const { rt, world } = await mount({ submit: async () => cancelled });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(text(rt)).toContain("You cancelled the passkey prompt. Nothing was sent."); // attempt 1: not sent (the harness works)
    await tick(100_000); // the person thinks about it for 100 s
    world.kit.signAndSubmit.mockImplementation(async () => relayDidNotAnswer);
    void clickButton(rt.tree, /Send 2 USDC/); // attempt 2
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // attempt 2 is unknown: it may still land
    // Only a moment has passed since attempt 2 settled: its payment can still reach the network.
    expect(text(rt)).not.toContain(PAST);
    expect(buttonLabels(rt.tree)).not.toContain("Start another cash-out");
    rt.unmount();
  });
});
