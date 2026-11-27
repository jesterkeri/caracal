// Adversary c7: the confirm screen states the anchor's fee in USDC whatever asset the anchor gave it in.
//
// Spec: goal 4 (a person is told an amount that is not the anchor's) and docs/decisions.md 2026-11-27
// (the confirm screen shows what the anchor asks; the anchor's record is the truth). The anchor's record
// carries fee_details: { total, asset } (test/fixtures/anchor/txn-pending-user-transfer-start.json:
// asset "stellar:USDC:GBBD47IF..."). Cause: parseTransaction() (src/lib/anchor/sep24.ts) keeps only
// fee_details.total and drops fee_details.asset; src/app/cashout/page.tsx prints `{txn.feeTotal} USDC`
// unconditionally. An anchor whose fee is in naira ("5000", iso4217:NGN) is shown as "5000 USDC" on the
// very screen the person confirms the payment from.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured record
// with ONE field edited, fee_details.asset), kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, text, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c7: the unit of the anchor's fee on the confirm screen", () => {
  it("control: the captured record (fee in Circle USDC) shows its fee as 0.2 USDC", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect((world.txn.fee_details as { asset: string }).asset).toBe("stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(text(rt)).toContain("0.2 USDC");
    rt.unmount();
  });

  it("a fee the anchor states in naira is not shown as USDC", async () => {
    const { rt, world } = await mount({ txn: { fee_details: { total: "5000", asset: "iso4217:NGN" } } });
    await toConfirm(rt, world);
    // the harness works: the confirm screen is open and shows the anchor's fee figure
    expect(text(rt)).toContain("Anchor fee");
    expect(text(rt)).toContain("5000");
    // the defect: the figure is labelled with a unit the anchor never gave
    expect(text(rt)).not.toContain("5000 USDC");
    rt.unmount();
  });
});
