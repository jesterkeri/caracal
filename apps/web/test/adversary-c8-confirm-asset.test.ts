// Adversary c8: the confirm screen states the anchor's amount_in in USDC, and offers Send, for a record
// whose amount_in_asset names something else.
//
// Spec: goal 4 (a person is told an amount or currency that is not the anchor's) and goal 5 (a control
// offered that cannot work); docs/decisions.md 2026-11-27 rows c5 ("Send is offered only while ... the
// anchor takes a payment") and c7 ("The confirm screen labels the anchor's ... asset: USDC only when it
// names Circle testnet USDC or none"). Cause: src/app/cashout/page.tsx prints `The anchor wants
// {txn.amountIn} USDC` and `Send {txn.amountIn} USDC to the anchor` with a literal "USDC", never through
// assetLabel() (the c7 helper used only for the fee row), although parseTransaction() keeps
// amountInAsset. src/lib/anchor/transfer.ts paymentFor() refuses such a record on the click ("asks to be
// paid in ..., not Circle testnet USDC"), so the enabled button can never work, yet it is offered.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured
// record with ONE field edited, amount_in_asset), kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttons, label, mount, text, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const enabledLabels = (tree: unknown) => buttons(tree).filter((b) => !b.props?.disabled).map(label);

describe("adversary c8: the asset of the amount the anchor wants on the confirm screen", () => {
  it("control: the captured record (amount_in_asset is Circle USDC) reads 2 USDC and offers Send 2 USDC", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(world.txn.amount_in_asset).toBe("stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(text(rt)).toContain("The anchor wants 2 USDC");
    expect(enabledLabels(rt.tree).some((l) => /^Send 2 USDC/.test(l))).toBe(true);
    rt.unmount();
  });

  it("an amount the anchor states in naira is not shown as USDC", async () => {
    const { rt, world } = await mount({ txn: { amount_in_asset: "iso4217:NGN" } });
    await toConfirm(rt, world);
    // the harness works: the confirm screen is open and shows the anchor's amount
    expect(text(rt)).toContain("The anchor wants");
    expect(text(rt)).toContain("Pay to account");
    // the defect: the figure is labelled with a unit the anchor never gave
    expect(text(rt)).not.toContain("The anchor wants 2 USDC");
  });

  it("no enabled Send button is offered for a record the page will refuse to pay (another asset)", async () => {
    const { rt, world } = await mount({ txn: { amount_in_asset: "iso4217:NGN" } });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("Pay to account"); // the harness works: the confirm screen is open
    expect(enabledLabels(rt.tree).filter((l) => /^Send/.test(l))).toEqual([]);
  });
});
