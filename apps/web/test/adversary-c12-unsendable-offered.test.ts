// Adversary c12: the confirm screen offers an enabled "Send ... USDC to the anchor" for anchor records
// that src/lib/anchor/transfer.ts paymentFor() is certain to refuse, so the control cannot work.
//
// Spec: goal 5 (a control offered that cannot work), with the c8 precedent in docs/decisions.md
// 2026-11-27 ("offers Send only when the anchor asks for Circle testnet USDC or names no asset ...
// paymentFor refuses it anyway") and c5 ("Send is offered only while the anchor's status is
// pending_user_transfer_start"). Cause: src/app/cashout/page.tsx offers Send whenever status is
// pending_user_transfer_start and the asset is USDC; it never asks paymentFor's other checks, so
//   (a) a text or hash memo (a smart wallet's Soroban payment can only carry a numeric id) and
//   (b) an amount_in that is not the amount the person confirmed (the interactive form let the person
//       type another figure, or the anchor changed it)
// both show "Send <amount> USDC to the anchor", and the click ends in "Nothing was sent". For (b) the
// label even reads "Send 5 USDC" when the person chose 2.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured
// record with ONE field edited), kit, popup.
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

const enabledSend = (tree: unknown) => buttons(tree).filter((b) => !b.props?.disabled).map(label).filter((l) => /^Send/.test(l));

describe("adversary c12: Send offered for a record paymentFor will always refuse", () => {
  it("control: the captured record (id memo, amount_in 2, confirmed 2) offers Send 2 USDC", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(text(rt)).toContain("Pay to account");
    expect(enabledSend(rt.tree)).toEqual(["Send 2 USDC to the anchor"]);
    rt.unmount();
  });

  it.each(["text", "hash"])("a %s memo cannot be carried by a smart wallet, so no enabled Send is offered", async (memoType) => {
    const { rt, world } = await mount({ txn: { withdraw_memo_type: memoType, withdraw_memo: memoType === "hash" ? "ZmFrZQ==" : "hello" } });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("Pay to account"); // the harness works: the confirm screen is open
    expect(enabledSend(rt.tree)).toEqual([]);
    rt.unmount();
  });

  it("an amount_in other than the 2 USDC the person confirmed offers no enabled Send", async () => {
    const { rt, world } = await mount({ txn: { amount_in: "5" } });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("The anchor wants 5 USDC"); // the harness works: the anchor's other figure is on screen
    expect(enabledSend(rt.tree)).toEqual([]);
    rt.unmount();
  });
});
