// Adversary c27: after a send whose outcome is unknown, the page offers "Start another cash-out" as the way
// forward, but the send guard's own hold (src/lib/anchor/send-guard.ts, 3 minutes past the last renewal)
// still blocks it, with text saying the earlier payment "may still go through".
//
// Two ways to reach it, both with the real page, send guard and storage:
//  A. the anchor reports "completed" (it has the USDC, so the payment is proven received) 3 s after an unknown
//     send: "Start another cash-out" is offered (canStartAnother: done && !mayStillLand), yet Continue stays
//     disabled for about 3 minutes under "An earlier USDC payment ... may still go through".
//  B. the anchor still waits for USDC 100 s after the kit's call settled: the page says "the payment can no
//     longer reach the network" and offers the button, while the guard still says "may still go through"
//     for about 80 s more.
//
// Spec: docs/decisions.md 2026-11-27 c13 row (the payment can land only for 90 s after the kit's call
// settles, then "the page ... offers 'Start another cash-out'") and c18 row ("Only completed and refunded
// prove the anchor received the first one"); goals 4 (told something false: "may still go through" after
// the anchor completed it, or after the page said it cannot) and 5 (a control offered that cannot work).
// Cause: src/app/cashout/page.tsx `canStartAnother` and `startAgain` never clear or consult the send-guard
// record, and send-guard.ts SETTLE_MS (3 min) is not the page's LAND_WINDOW_MS (90 s); the record is also
// never removed when the anchor's completed or refunded status proves the payment arrived.
//
// The assertions are conditional on the button being offered, so any fix passes: stop offering it while the
// guard holds, or let the guard go when the page says it can. Only "offered, then refused" fails.
//
// Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor (fetch stub),
// kit (the real failure shape of a relay that did not answer: code 5003, no hash), popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, buttons, clickButton, find, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const relayDidNotAnswer = { success: false, error: { code: 5003, message: "Relayer request failed with status 502" } };
const START_ANOTHER = "Start another cash-out";

/** Presses "Start another cash-out", types 2 and returns whether Continue is disabled and the page's text. */
async function startAnother(rt: Awaited<ReturnType<typeof mount>>["rt"]) {
  void clickButton(rt.tree, /Start another cash-out/);
  await tick(50);
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  const cont = buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));
  return { continueDisabled: cont?.props?.disabled === true, page: text(rt) };
}

async function unknownSend(over: Parameters<typeof mount>[0] = {}) {
  const m = await mount({ submit: async () => relayDidNotAnswer, ...over });
  await toConfirm(m.rt, m.world);
  void clickButton(m.rt.tree, /Send 2 USDC/);
  await tick(50);
  expect(text(m.rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed
  return m;
}

describe("adversary c27: 'Start another cash-out' is offered while the send guard still refuses it", () => {
  it("control: long after the unknown send (200 s) the button is offered and Continue works", async () => {
    const { rt } = await unknownSend();
    await tick(200_000);
    expect(buttonLabels(rt.tree)).toContain(START_ANOTHER);
    const after = await startAnother(rt);
    expect(after.page).not.toMatch(/may still go through/);
    expect(after.continueDisabled).toBe(false);
    rt.unmount();
  });

  it("A: the anchor completed the withdrawal (the payment arrived); if the page offers another cash-out it must work, and not say the payment may still go through", async () => {
    const { rt, world } = await unknownSend();
    world.txn.status = "completed"; // the anchor has the USDC
    await tick(3100);
    expect(text(rt)).toContain("The anchor marked the withdrawal complete"); // the harness shows completed
    if (buttonLabels(rt.tree).includes(START_ANOTHER)) {
      const after = await startAnother(rt);
      expect(after.page).not.toMatch(/may still go through/);
      expect(after.continueDisabled).toBe(false);
    }
    rt.unmount();
  });

  it("B: 100 s after the unknown send, if the page offers another cash-out it must work, and not say the payment may still go through", async () => {
    const { rt } = await unknownSend();
    await tick(100_000);
    if (buttonLabels(rt.tree).includes(START_ANOTHER)) {
      const after = await startAnother(rt);
      expect(after.page).not.toMatch(/may still go through/);
      expect(after.continueDisabled).toBe(false);
    }
    rt.unmount();
  });
});
