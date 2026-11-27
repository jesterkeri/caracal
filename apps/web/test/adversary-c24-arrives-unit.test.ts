// Adversary c24: the unit of "Arrives" (amount_out_asset) is neither shown nor part of the confirmed quote.
//
// Spec: docs/decisions.md 2026-11-27 rows c11 ("What the person saw now includes the quote; any change refuses
// Send once": the amount wanted and its asset, the fee and its asset, and what arrives) and c7/c8 (the confirm
// screen labels the anchor's amounts with the anchor's own asset). Attacker goal 4 (an amount that is not the
// anchor's) and goal 1 (USDC leaves under a quote the person did not confirm).
// Cause: src/lib/anchor/sep24.ts parseTransaction never reads `amount_out_asset`, so the confirm screen prints
// "Arrives 1.8 (simulated)" with no unit, and payTo() in src/app/cashout/page.tsx cannot see it change. The
// anchor's real record (test/fixtures/anchor/txn-pending-user-transfer-start.json) says amount_out_asset
// "iso4217:USD". A record that keeps every other field but turns that "1.8 USD" into "1.8 NGN" (a different
// payout, worth a tiny fraction) is paid on the next Send with no warning, and the screen never showed a unit
// either before or after.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor (the repo's captured fixture
// with amount_out_asset edited), kit, Supabase, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttons, clickButton, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c24: the unit of what arrives", () => {
  it("control: an unchanged quote is paid once, and the fixture's record names USD as the unit", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(world.txn.amount_out_asset).toBe("iso4217:USD");
    expect(text(rt)).toContain("1.8 (simulated)");
    await tick(3100);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("the confirm screen shows the unit the anchor gave for what arrives", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    // today: "Arrives 1.8 (simulated)", no unit anywhere on the screen
    expect(text(rt)).toMatch(/\bUSD\b/); // not the "USD" inside "USDC"
    rt.unmount();
  });

  it("a payout unit changed from USD to NGN after the confirm screen is refused on the next Send", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain("1.8 (simulated)"); // the person looks at this quote
    world.txn.amount_out_asset = "iso4217:NGN"; // same amount_in, fee, amount_out, account and memo
    await tick(3100); // the poll lands
    const send = buttons(rt.tree).find((b) => /^Send/.test(label(b)) && !b.props?.disabled);
    if (send) {
      void send.props!.onClick!(); // the click the person was about to make
      await tick(50);
    }
    // today: the USDC is signed and submitted under the new unit
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
