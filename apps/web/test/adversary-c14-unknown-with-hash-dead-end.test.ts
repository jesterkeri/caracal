// Adversary c14: a USDC send whose confirmation poll timed out (kit code 5004 WITH the transaction hash)
// leaves the person with no control and no instruction while the anchor still waits for USDC.
//
// Spec: goal 5 (no way forward). docs/decisions.md 2026-11-27 c13 row: "After an unknown send ... if the
// payment never landed the anchor stays at pending_user_transfer_start and the page had no way forward ...
// 90 s after it settled, with the anchor still waiting, the page says the payment can no longer reach the
// network, to check the balance, and offers 'Start another cash-out'." c13 fixed only the no-hash unknown
// (src/app/cashout/page.tsx `unknownWaiting` requires `sentHash === null`). The kit raises 5004 with a hash
// when its 10-attempt poll of getTransaction ends without a result (node_modules/smart-account-kit
// dist/kit/tx-ops.js sendAndPoll, last line): the same "never landed" case, now with a hash, and the
// message tells the person only "Do not send it again".
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit (the failure shape
// is the kit's real one for a confirmation timeout: code 5004, hash set).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, find, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const HASH = "ab".repeat(32);
const wayForward = (rt: { tree: unknown }) => buttonLabels(rt.tree).length > 0 || find(rt.tree, (e) => e.type === "input").length > 0 || /reload|refresh/i.test(text(rt));

describe("adversary c14: unknown send with a hash, anchor still waiting", () => {
  it("control: the same failure with no hash gives a way forward after two minutes", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: false, error: { code: 5003, message: "Relayer request failed with status 502" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    await tick(120_000);
    expect(text(rt)).toContain("The anchor is waiting for your USDC.");
    expect(wayForward(rt)).toBe(true);
    rt.unmount();
  });

  it("the kit's confirmation poll timed out (5004, hash set) and the anchor still waits after ten minutes: the person has a way forward", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: false, hash: HASH, error: { code: 5004, message: "Transaction confirmation timed out" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    await tick(600_000);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed (the harness works)
    expect(text(rt)).toContain("The anchor is waiting for your USDC."); // and the anchor never moves on
    expect(wayForward(rt)).toBe(true);
    rt.unmount();
  });
});
