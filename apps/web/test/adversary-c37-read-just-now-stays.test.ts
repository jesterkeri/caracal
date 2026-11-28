// Adversary c37 #2: "is X USDC now (read just now)" stays on screen for as long as the page is open, though the
// balance is read once and never again.
//
// Spec: the pass brief's goal 3 ("the page states something false about ... how fresh the balance is") and
// docs/decisions.md 2026-11-27 adversary c16 and 2026-11-28 adversary c36 (2): "the page says the payment can no
// longer land only after that read" and "'is 90 USDC now (read just now)' was printed over a balance read before the
// payment could land". The wording "now (read just now)" is a freshness claim about the number beside it, and the
// advice after it ("If it did not drop and no other USDC came in meanwhile ... you can start another cash-out")
// is only as good as that number is current.
// Cause: src/app/cashout/page.tsx lines 816-818 print "(read just now)" for as long as pastLanding holds, and
// pastLanding stays true once landingOver is set (it is reset only by startAgain or a new send). The balance is
// read when the landing window ends, when the anchor's status changes, and on Start again; nothing else, so after
// half an hour the same words stand over a half-hour-old figure.
//
// Assertion: after 30 minutes on the page, either the balance has been read again, or the text no longer says it
// was read just now. Passes for a fix that re-reads (periodically, or when the person returns to the tab) and for
// one that rewords or drops the claim; the control (right after the window ends) passes today.
//
// Real: the page and src/lib/anchor/*, send-guard, Web Locks stand-in, through the c2 hook runtime. Faked: anchor,
// kit (a send whose outcome is unknown: the relay "did not answer"), popup.
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

const UNKNOWN = async () => ({ success: false as const, error: { code: 5003, message: "The fee relayer did not answer. Check your activity before trying again." } });
const CLAIM = /Your USDC balance was [^.]*is [^.]* USDC now \(read just now\)/;

async function pastLanding() {
  const { rt, world } = await mount({ submit: UNKNOWN });
  await toConfirm(rt, world);
  void clickButton(rt.tree, /Send 2 USDC/);
  await tick(130_000); // the landing window (90 s) is over and the network is past closeBy
  return { rt, world };
}

describe("adversary c37: the freshness claim after an unknown send", () => {
  it("control: when the landing window ends the balance is read and the page says so", async () => {
    const { rt, world } = await pastLanding();
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    expect(text(rt)).toMatch(CLAIM);
    expect(world.kit.readBalance.mock.calls.length).toBeGreaterThan(1);
    rt.unmount();
  });

  it("thirty minutes later the page does not still say the balance was read just now without reading it again", async () => {
    const { rt, world } = await pastLanding();
    const readsThen = world.kit.readBalance.mock.calls.length;
    await tick(30 * 60_000);
    const readAgain = world.kit.readBalance.mock.calls.length > readsThen;
    const stillClaims = CLAIM.test(text(rt));
    expect(stillClaims && !readAgain, "'(read just now)' stands over a balance read 30 minutes ago").toBe(false);
    rt.unmount();
  });
});
