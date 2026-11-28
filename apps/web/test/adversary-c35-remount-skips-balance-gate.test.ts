// Adversary c35: leaving the cash-out page and coming back (a client-side navigation, the same tab) while this
// tab's own payment is still being sent lets the new page offer a cash-out on a balance read BEFORE that payment
// could land.
//
// Spec: src/lib/anchor/send-guard.ts top comment ("A passed record does not let the page offer a cash-out at once:
// the balance must first be read at a ledger past its closeBy") and docs/decisions.md 2026-11-28 row on Codex split
// R4 #2 ("while a record the network has passed is kept ..., nothing starts or sends until the balance shown was
// read at a ledger past its closeBy"). Attacker goal 1 and 3 (leaving and returning to the page; paying while an
// earlier payment may have landed, on a balance that does not show it).
//
// Cause: send-guard.ts recordCloseBy() returns null for a record whose id is in the module-level `inFlight` set, "this
// tab's payments still being sent", so the page that renders is exempt from the balance gate. The exemption is meant
// for the page instance that is running the send; but `inFlight` is per tab, not per page instance. A page mounted
// again while the first instance's kit call has not settled (its send() closure runs on after the unmount, and calls
// guard.finish only when the kit answers) is exempt too. The hold lifts when the network passes closeBy, the gate
// that would make it re-read the balance is skipped, and it offers Continue next to the balance it read at mount,
// before the payment landed.
//
// How: the payment's kit call never answers. The page is unmounted and mounted again (same module state, same
// storage). The payment lands at ledger 105 (the fake chain shows 88 USDC from then on, 90 before). The second
// page read its balance at ledger 100. Once the network is past closeBy (118) the hold is gone; the page must not
// offer a cash-out on the 90 USDC it read at ledger 100. Passes for any fix that keeps the gate or re-reads the
// balance (the shown balance is then 88, or Continue stays disabled).
//
// Real: the page, src/lib/anchor/*, send-guard, Web Locks stand-in, through the c2 hook runtime. Faked: anchor,
// kit (a signAndSubmit that never answers), popup, the chain's balance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, clickButton, label, mount, runtime, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const KEY = `caracal.cashout.send.${WALLET}`;
const continueButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));
const BEFORE = BigInt(900_000_000); // 90 USDC
const AFTER = BigInt(880_000_000); // 88 USDC: the 2 USDC payment landed

/** The chain: the payment lands at ledger 105; the harness's ledger is 100 + one per 5 s of the fake clock. */
function chain(startedAt: number) {
  const ledger = () => 100 + Math.floor((Date.now() - startedAt) / 5_000);
  return async () => (ledger() >= 105 ? AFTER : BEFORE);
}

/** Types 2 USDC into the page's amount field. */
async function typeAmount(rt: { tree: unknown }) {
  const { find } = await import("./adversary-c2-harness");
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
}

describe("adversary c35: a page mounted again while this tab's payment is unsettled", () => {
  it("control: another tab's record (not in this tab's in-flight set) keeps the balance gate, and the page shows 88", async () => {
    const startedAt = Date.now();
    const store = new Map<string, string>([[KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 118, anchorId: "other-withdrawal-id", hash: null })]]);
    const { rt, world } = await mount({ store });
    world.kit.readBalance.mockImplementation(chain(startedAt));
    await tick(50);
    await typeAmount(rt);
    await tick(110_000); // the network is at ledger 122, past closeBy 118
    // Either Continue is still disabled, or the balance on screen is the one that shows the payment.
    const enabled = continueButton(rt)?.props?.disabled === false;
    if (enabled) expect(text(rt)).toMatch(/USDC in the wallet: 88 USDC/);
    expect(text(rt)).not.toMatch(/USDC in the wallet: 90 USDC.*Continue/);
    rt.unmount();
  });

  it("a page mounted again while the first instance's send is still unsettled does not offer a cash-out on the 90 USDC read before the payment landed", async () => {
    const startedAt = Date.now();
    const store = new Map<string, string>();
    const first = await mount({ store, submit: () => new Promise(() => {}) });
    first.world.kit.readBalance.mockImplementation(chain(startedAt));
    await toConfirm(first.rt, first.world);
    void clickButton(first.rt.tree, /Send 2 USDC/);
    await tick(500);
    expect(first.world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    const record = JSON.parse(store.get(KEY) ?? "null") as { closeBy: number };
    expect(record.closeBy).toBe(118);

    // Leave the page and come back: a new instance of the same component, in the same tab (same module state).
    first.rt.unmount();
    const Page = (await import("../src/app/cashout/page")).default as () => unknown;
    const second = runtime(Page);
    Object.assign(first.rt.hooks, second.hooks); // the mocked react routes hooks to the newest instance
    second.start();
    await tick(50);
    await typeAmount(second);
    expect(text(second)).toMatch(/USDC in the wallet: 90 USDC/);
    expect(text(second)).toMatch(/may still go through/); // control: it is held while closeBy has not passed
    expect(continueButton(second)?.props?.disabled).toBe(true);

    await tick(110_000); // ledger 122: the network is past closeBy 118, and the payment landed at ledger 105
    const enabled = continueButton(second)?.props?.disabled === false;
    // Offered a cash-out: the balance on screen must be one that shows the payment.
    if (enabled) expect(text(second)).toMatch(/USDC in the wallet: 88 USDC/);
    expect(text(second)).not.toMatch(/USDC in the wallet: 90 USDC/);
    second.unmount();
  });
});
