// Adversary c16: when the landing window ends, the page tells the person to judge by "your USDC balance
// above", but that balance was last read when the send ended, before a late payment could land.
//
// Spec: goals 1 and 4 (a payment sent twice, a person told something false) and docs/decisions.md
// 2026-11-27 c13 row: "90 s after it settled, with the anchor still waiting, the page says the payment can
// no longer reach the network, to check the balance, and offers 'Start another cash-out'", and the
// 2026-11-27 Cash-out fixes row (2): "The wallet's USDC balance is read again when a send ends, when the
// anchor's status changes, and on 'Start another cash-out'".
// Cause: src/app/cashout/page.tsx. The unknown send reads the balance once (refreshBalance() right after
// sendToAnchor), and the only later reads are on a change of the anchor's status (the effect on
// [txn?.status]) and in startAgain. The timer that sets `landingOver` (the effect on [sendSettledAt]) does
// not read the balance. So when the relay's answer was lost at once, the payment lands 30 s later, and the
// anchor is slow to notice it (its status stays pending_user_transfer_start), the page shows the old
// balance and says "If your USDC balance above did not drop, it did not go through and you can start
// another cash-out": the person starts a second cash-out and pays twice.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit (the real failure
// shape of a relay that did not answer: code 5003 with no hash), and the wallet's balance on the chain.
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
const BEFORE = BigInt(900_000_000); // 90 USDC (7 places)
const AFTER = BigInt(880_000_000); // 88 USDC: the 2 USDC payment landed

describe("adversary c16: the balance the page points at is current when the landing window ends", () => {
  it("control: the page reads the balance again when the anchor's status changes", async () => {
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    world.kit.readBalance.mockImplementation(async () => BEFORE);
    await toConfirm(rt, world);
    expect(text(rt)).toContain("USDC in the wallet: 90 USDC");
    world.kit.readBalance.mockImplementation(async () => AFTER);
    world.txn.status = "pending_user_transfer_complete"; // the anchor's status changes: the page reads again
    await tick(3100);
    expect(text(rt)).toContain("USDC in the wallet: 88 USDC");
    rt.unmount();
  });

  it("an unknown send whose payment lands late, with the anchor slow to notice: the balance shown is the current one", async () => {
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    world.kit.readBalance.mockImplementation(async () => BEFORE);
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed
    expect(text(rt)).toContain("USDC in the wallet: 90 USDC"); // read when the send ended: nothing had landed yet
    await tick(30_000);
    world.kit.readBalance.mockImplementation(async () => AFTER); // the payment lands on the chain; the anchor's status does not move
    await tick(100_000);
    expect(world.txn.status).toBe("pending_user_transfer_start");
    expect(text(rt)).toContain(PAST); // the page now says to judge by the balance above, and offers a second cash-out
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    expect(text(rt)).toContain("USDC in the wallet: 88 USDC"); // so that balance must be the current one
    rt.unmount();
  });
});
