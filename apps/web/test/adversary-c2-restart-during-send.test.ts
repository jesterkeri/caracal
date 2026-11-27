// Adversary c2: "Start another cash-out" is offered while a payment is still being sent.
//
// src/app/cashout/page.tsx: `done` is true as soon as the anchor's record is in a final status,
// and the "Start another cash-out" button is shown whenever `done` is true, in any phase. During
// phase "sending" (the passkey prompt and the relay are still working on the USDC payment), the
// poll is still running. The test anchor completes a withdrawal within seconds of seeing the
// payment (docs/research/anchor-spike-2026-11-27.md section 4), which can be before the kit's
// own confirmation wait returns. The page then offers "Start another cash-out" next to
// "Waiting for your passkey...". startAgain() clears the session, the transaction and the send
// lock; when the in-flight send then returns, send() sets phase "watching" with no transaction,
// and the page shows nothing at all: no status, no payment link, no control (goals 4 and 5).
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, find, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const HASH = "cb".repeat(32);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** Confirm screen, Send pressed, the passkey and relay still working (the send is held open). */
async function sendingWithHeldSend() {
  let finishSend!: (r: unknown) => void;
  const held = mount({ submit: () => new Promise((r) => (finishSend = r)) });
  const { rt, world } = await held;
  await toConfirm(rt, world);
  void clickButton(rt.tree, /Send 2 USDC/);
  await tick(50);
  expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
  expect(buttonLabels(rt.tree)).toContain("Waiting for your passkey...");
  return { rt, world, finishSend: () => finishSend({ success: true, hash: HASH }) };
}

describe("adversary c2: a restart offered while the payment is in flight", () => {
  it("control: if nothing is pressed, the finished payment shows the anchor's completion and the hash", async () => {
    const { rt, world, finishSend } = await sendingWithHeldSend();
    world.txn.status = "completed";
    await tick(3100);
    finishSend();
    await tick(50);
    expect(text(rt)).toMatch(/marked the withdrawal complete/);
    expect(text(rt)).toContain(HASH);
    rt.unmount();
  });

  it("pressing the offered 'Start another cash-out' while sending does not blank the page when the payment then lands", async () => {
    const { rt, world, finishSend } = await sendingWithHeldSend();
    world.txn.status = "completed"; // the anchor has already seen the payment
    await tick(3100);
    // The page offers it, next to "Waiting for your passkey...".
    if (buttonLabels(rt.tree).some((l) => /Start another cash-out/.test(l))) clickButton(rt.tree, /Start another cash-out/); // (a fix may stop offering it)
    await tick(50);
    finishSend(); // the USDC payment lands, and the page is told so
    await tick(50);
    const showsSomething = text(rt).includes(HASH) || buttonLabels(rt.tree).length > 0 || find(rt.tree, (e) => e.type === "input").length > 0;
    expect(showsSomething).toBe(true); // a payment was sent: the page must say so or offer a way forward
    rt.unmount();
  });
});
