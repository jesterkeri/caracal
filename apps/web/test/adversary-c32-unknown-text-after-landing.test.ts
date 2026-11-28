// Adversary c32: after an unknown USDC send, once the landing window is over and the network has passed the payment's
// closeBy, the page says in one box "The anchor still has not received the USDC, and the payment can no longer reach
// the network ... you can start another cash-out", and in the box above it still says "Caracal could not confirm the
// USDC payment. It may still go through ... Do not send it again." The two contradict, and the second is the stale
// refusal text c31 removed for another tab's hold, here left for the page's own payment.
//
// Cause: src/app/cashout/page.tsx send() stores the unknown outcome's text with setProblem(r.message) (the
// `r.kind === "unknown"` branch); `shownProblem` (page.tsx, "const shownProblem") drops a stored text only when
// `problem === heldText && !hold.held`, and heldText is set only by refuseHeld. Nothing clears `problem` when
// `landingOver` becomes true, so it is drawn (`{shownProblem && ...}`) beside the pastLanding paragraph.
//
// Spec: docs/decisions.md 2026-11-27 c13 row ("90 s after it settled, with the anchor still waiting, the page says
// the payment can no longer reach the network ... and offers 'Start another cash-out'"), the 2026-11-28 c31 row (a
// refusal about a payment that may still land "is not kept on screen" once the network has passed it), and c27's
// "the page must not say what the guard no longer holds". Attacker goal 4: a person is told something false ("may
// still go through" when the page itself says it cannot) and goal 5 (no clear way forward: "Do not send it again"
// beside an offered "Start another cash-out").
//
// The test passes for any fix that stops saying "may still go through" once the page says the payment can no longer
// reach the network, and also requires that the page still offers "Start another cash-out" (so removing the
// way forward is not a fix). Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor,
// popup, and the kit's real failure shape for a relay that did not answer (code 5003, no hash; as the c27 test).
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
const PAST = "can no longer reach the network";

async function unknownSend() {
  const m = await mount({ submit: async () => relayDidNotAnswer });
  await toConfirm(m.rt, m.world);
  void clickButton(m.rt.tree, /Send 2 USDC/);
  await tick(50);
  return m;
}

describe("adversary c32: the unknown-send text outlives the landing window", () => {
  it("control: right after the unknown send, the page says the payment may still go through and offers no new cash-out", async () => {
    const { rt } = await unknownSend();
    expect(text(rt)).toContain("It may still go through");
    expect(text(rt)).not.toContain(PAST);
    expect(buttonLabels(rt.tree)).not.toContain("Start another cash-out");
    rt.unmount();
  });

  it("200 s later the page says the payment can no longer reach the network, and no longer says it may still go through", async () => {
    const { rt } = await unknownSend();
    await tick(200_000);
    expect(text(rt)).toContain(PAST);
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out"); // the way forward stays
    // Observed on 91157e7: "Caracal could not confirm the USDC payment. It may still go through. ... Do not send it
    // again." is still drawn above "The anchor still has not received the USDC, and the payment can no longer reach
    // the network".
    expect(text(rt)).not.toMatch(/may still go through/);
    rt.unmount();
  });
});
