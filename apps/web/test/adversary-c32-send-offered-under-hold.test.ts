// Adversary c32: the confirm screen offers an enabled "Send N USDC to the anchor" while another tab of this browser
// holds a payment that may still land, a Send the send guard is certain to refuse.
//
// How it happens: two tabs of one browser are both at the confirm screen for their own anchor withdrawals (each
// passed the hold check when it pressed Continue, before any payment existed). One tab sends, and its outcome is
// unknown, so it leaves a record in localStorage (send-guard.ts Rec) that holds the wallet until the network passes
// its closeBy. The other tab's page re-renders on its 3 s status poll and computes `hold` (page.tsx, `const hold =
// sendHold(...)`), which is now held, but the confirm card's Send button is `disabled={phase === "sending"}` only
// (page.tsx, the confirm card): it is offered and enabled, with no hold text beside it (the hold text is rendered
// only in the preview phase). Pressing it can only end in the refusal "An earlier USDC payment ... may still go
// through".
//
// Spec: docs/decisions.md 2026-11-28 c27 row ("the page never offers what the hold would refuse"; the hold lifts
// "only when an RPC shows a ledger past closeBy"), the c8/c12/c30 rule restated in the c30 row ("The page offered a
// control whose end it would refuse"), and send-guard.ts header ("no cash-out of this wallet starts or sends while
// the record says it can still land"). Attacker goal 5: a control offered that cannot work. No money moves: the
// guard refuses; the harm is a control that cannot work and a person who is not told why until they press it.
//
// The test passes for any fix that stops offering Send while the hold holds (disabled or absent), and fails only
// while an enabled Send stands over a hold. Real: the page, src/lib/anchor/*, send-guard, through the c2 hook
// runtime. Faked: anchor, kit, popup (adversary-c2-harness.ts). The other tab's record is written with the repo's
// own record shape under the real key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, clickButton, label, mount, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const KEY = `caracal.cashout.send.${WALLET}`;
/** Another tab's unknown payment: closeBy 40 ledgers (200 s) past the harness's ledger 100, so it holds for the whole test. */
const otherTabRecord = () => JSON.stringify({ v: 2, id: "other-tab", closeBy: 140, anchorId: "other-withdrawal-id", hash: null });
const sendButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Send 2 USDC/.test(label(b)));

describe("adversary c32: Send is offered while another tab's payment holds the wallet", () => {
  it("control: with no other payment, the confirm screen offers an enabled Send and it pays", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(sendButton(rt)?.props?.disabled).toBe(false);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("control: the offered Send is refused by the guard while the other tab's payment can still land", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    store.set(KEY, otherTabRecord());
    await tick(3100); // the status poll re-renders the page: it can now see the hold
    // Control changed after the fix (disclosed in docs/decisions.md): Send is now disabled under the hold, so its
    // handler is called directly, as a press would; the guard still refuses it.
    void (sendButton(rt)!.props!.onClick as () => unknown)();
    await tick(100);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled(); // refused, as it must be
    rt.unmount();
  });

  it("while another tab's payment holds the wallet, the confirm screen does not offer an enabled Send", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store });
    await toConfirm(rt, world);
    store.set(KEY, otherTabRecord());
    await tick(3100); // one status poll later the page has re-rendered and `hold` is held
    const send = sendButton(rt);
    // Observed on 91157e7: the button is there and enabled (disabled === false), and its only possible result is a refusal.
    expect(send === undefined || send.props?.disabled === true).toBe(true);
    rt.unmount();
  });
});
