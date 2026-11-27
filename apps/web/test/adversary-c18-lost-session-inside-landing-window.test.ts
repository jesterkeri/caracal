// Adversary c18: after a send whose outcome is unknown (the relay did not answer, so the payment can still
// land for up to 90 s), the anchor refuses the session (401/403 on the status read). The page then offers
// "Start another cash-out" at once, inside the landing window, while its own text says the payment "can
// still reach the network for a short while" and "this page offers to start another cash-out" only
// after that. A second cash-out started inside the window pays a second time if the first payment lands.
//
// Spec: goal 1 (USDC sent twice) and docs/decisions.md 2026-11-27 c13 row: "Once the kit's send has
// settled, a payment can land only while the relay may still send it ... 90 s after it settled, with the
// anchor still waiting, the page says the payment can no longer reach the network, to check the balance,
// and offers 'Start another cash-out'. Before that it says so and how to recover by reloading." and the
// c15/c16 rows ("a second cash-out ... pays twice"). The c2 row ("'Start another cash-out' ... is offered
// when the anchor stops accepting the session") was written before the landing window and was not
// reconciled with it.
// Cause: src/app/cashout/page.tsx `canStartAnother = (done || lostSession || pastLanding) && ...`: the
// `lostSession` term ignores `unknownSend` and the landing window.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor (status endpoint
// refusal), kit (the real failure shape of a relay that did not answer: code 5003, no hash), popup.
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

const relayDidNotAnswer = { success: false, error: { code: 5003, message: "Relayer request failed with status 502" } };
const START_ANOTHER = "Start another cash-out";

describe("adversary c18: a lost anchor session does not end the landing window of an unknown send", () => {
  it("control: with a readable status, an unknown send offers no second cash-out inside the window, and does after it", async () => {
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    await tick(3100);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed
    expect(text(rt)).toContain("The payment can still reach the network for a short while");
    expect(buttonLabels(rt.tree)).not.toContain(START_ANOTHER);
    await tick(100_000);
    expect(text(rt)).toContain("can no longer reach the network");
    expect(buttonLabels(rt.tree)).toContain(START_ANOTHER);
    rt.unmount();
  });

  it("the anchor refuses the session 3 s after the unknown send: no second cash-out is offered while the payment can still land", async () => {
    let code = 200;
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer, txnStatusCode: () => code });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    code = 403; // the anchor's token is refused from now on
    await tick(3100);
    expect(text(rt)).toMatch(/no longer accepts this session/); // the page knows (the harness works)
    expect(text(rt)).toContain("The payment can still reach the network for a short while"); // and still says it may land
    expect(buttonLabels(rt.tree)).not.toContain(START_ANOTHER);
    rt.unmount();
  });
});
