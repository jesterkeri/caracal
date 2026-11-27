// Adversary c19: after an unknown send, the page tells the person "Your USDC balance was X USDC when you
// pressed Send", but X is the last balance the page happened to read (when the confirm screen appeared),
// not the wallet's balance at the moment Send was pressed. If USDC arrived in the wallet in between (a
// freelancer's wallet receives invoice payments), the "before" number is false, and the page's own
// comparison hides a payment that did leave: the wallet held 95 USDC at the press, 93 USDC after the
// payment landed, and the page says "was 90 ... is 93 now. If it did not drop, the payment did not go
// through and you can start another cash-out", then offers "Start another cash-out" (a second payment).
//
// Spec: goals 1 and 4 (a second payment; an amount that is not the chain's), and docs/decisions.md
// 2026-11-27 c16 row: "it also states the balance when Send was pressed and the one just read".
// Cause: src/app/cashout/page.tsx send(): `setBalanceBeforeSend(balance)` records the last displayed read
// (state), which is refreshed only on boot, on an anchor status change and after a send; nothing reads the
// chain when Send is pressed. The text built from it is at the `pastLanding` message.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit (the real failure
// shape of a relay that did not answer: code 5003, no hash), and the wallet's balance on the chain.
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
const usdc = (n: number) => BigInt(n) * BigInt(10_000_000);

describe("adversary c19: the balance the page calls 'when you pressed Send' is the wallet's at that moment", () => {
  it("control: nothing arrives in between, so the page's before and after numbers are the chain's", async () => {
    let chain = usdc(90);
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    world.kit.readBalance.mockImplementation(async () => chain);
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    chain = usdc(88); // the payment lands
    await tick(50);
    await tick(100_000);
    expect(text(rt)).toContain("can no longer reach the network");
    expect(text(rt)).toContain("was 90 USDC when you pressed Send and is 88 USDC now");
    rt.unmount();
  });

  it("USDC arrived after the confirm screen was read and before Send: the page must not state the old number as the balance at Send", async () => {
    let chain = usdc(90);
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    world.kit.readBalance.mockImplementation(async () => chain);
    await toConfirm(rt, world);
    expect(text(rt)).toContain("USDC in the wallet: 90 USDC"); // what the page last read
    chain = usdc(95); // an invoice payment arrives; the page does not read again
    await tick(50);
    void clickButton(rt.tree, /Send 2 USDC/); // the wallet holds 95 USDC at this moment
    chain = usdc(93); // the 2 USDC payment lands (the relay's answer was lost)
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    await tick(100_000);
    expect(world.txn.status).toBe("pending_user_transfer_start"); // the anchor has not noticed it
    expect(text(rt)).toContain("can no longer reach the network"); // the page now judges by the balance
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    // The wallet held 95 USDC when Send was pressed. The page says 90, and so reads 93 as "did not drop".
    expect(text(rt)).not.toContain("was 90 USDC when you pressed Send");
    rt.unmount();
  });
});
