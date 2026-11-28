// Codex cash-out R2 (REVISE, 1 finding, P1): a payment that is certain to have gone through removed the shared record
// at once, and so did anchorReceived, but cash-out kept no ledger that later pages must read the balance past (the
// split page's readAfter). Another tab, or the page opened again, could then keep a balance read before the payment
// and offer another cash-out on it. Now, under the wallet's Web Lock and before a record is removed or replaced, the
// ledger the balance must be read past is kept in this browser (caracal.cashout.readAfter.<wallet>, only ever
// raised): the ledger the payment landed in less one (or its closeBy when the kit did not say), a received or
// replaced record's closeBy, or the ledger of the person's check. When it cannot be kept, the record stays, and its
// closeBy gates every page. Both starting and sending wait for a balance read past it, and Send checks again under
// the lock, where another tab's payment cannot end unseen (as split R5 #1).
//
// Real: the page, src/lib/anchor/*, send-guard, the Web Locks stand-in (c2 harness). Faked: anchor, kit, popup, chain.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, clickButton, label, mount, runtime, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const KEY = `caracal.cashout.send.${WALLET}`;
const READ_AFTER = `caracal.cashout.readAfter.${WALLET}`;
const continueButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));
const BEFORE = BigInt(900_000_000); // 90 USDC
const AFTER = BigInt(880_000_000); // 88 USDC: the 2 USDC payment is in the balance

async function typeAmount(rt: { tree: unknown }) {
  const { find } = await import("./adversary-c2-harness");
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
}

describe("Codex cash-out R2: a page opened after a confirmed payment waits for a balance read past it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    unmock();
  });

  it("the page opened again right after a confirmed payment does not offer a cash-out on a balance a lagging node read before it", async () => {
    const startedAt = Date.now();
    const store = new Map<string, string>();
    // The kit does not say which ledger the payment was included in (its `ledger` is optional).
    const first = await mount({ store, submit: async () => ({ success: true, hash: "cb".repeat(32) }) });
    // The node that answers balance reads lags: it shows the payment only from ledger 105.
    first.world.kit.readBalance.mockImplementation(async () => (100 + Math.floor((Date.now() - startedAt) / 5_000) >= 105 ? AFTER : BEFORE));
    await toConfirm(first.rt, first.world);
    void clickButton(first.rt.tree, /Send 2 USDC/);
    await tick(500);
    expect(first.world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(text(first.rt)).toMatch(/was confirmed on Stellar/);

    // Another copy of the page (another tab, or this one opened again) starts from nothing but this browser's storage.
    first.rt.unmount();
    const Page = (await import("../src/app/cashout/page")).default as () => unknown;
    const second = runtime(Page);
    Object.assign(first.rt.hooks, second.hooks);
    second.start();
    await tick(50);
    await typeAmount(second);
    const offered = continueButton(second)?.props?.disabled === false;
    if (offered) expect(text(second), "a cash-out is offered next to the balance read before the payment").toMatch(/USDC in the wallet: 88 USDC/);

    await tick(110_000); // the network is past the payment's closeBy, and the node shows the payment
    expect(text(second)).toMatch(/USDC in the wallet: 88 USDC/);
    expect(continueButton(second)?.props?.disabled).toBe(false); // and the way forward comes back on its own
    second.unmount();
  });
});

/** A browser whose storage refuses only the read-after ledger (full, or a policy). */
function storage(opts: { refuseReadAfter?: boolean; kept?: Map<string, string> } = {}) {
  const kept = opts.kept ?? new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (opts.refuseReadAfter && k === READ_AFTER) throw new Error("QuotaExceededError");
        kept.set(k, v);
      },
      removeItem: (k: string) => void kept.delete(k),
    },
  });
  return kept;
}

async function guard() {
  vi.resetModules();
  return import("../src/lib/anchor/send-guard");
}

describe("Codex cash-out R2: the guard keeps the read-after ledger before a record goes, or keeps the record", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("a confirmed payment whose kit said its ledger leaves that ledger less one as the read-after ledger", async () => {
    const kept = storage();
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1000, undefined, 1000);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // The real kit's TransactionResult says the ledger the payment was included in.
    await begun.guard.submit({ signAndSubmit: async () => ({ success: true, hash: "h", ledger: 1005 }) }, { needsNonInvokerSigningBy: () => [WALLET] } as never);
    begun.guard.finish("sent");
    await begun.guard.lockFree;
    expect(kept.has(KEY)).toBe(false);
    expect(g.readPastBy(WALLET)).toBe(1004);
  });

  it("a confirmed payment whose kit did not say its ledger leaves its closeBy as the read-after ledger", async () => {
    storage();
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1000, undefined, 1000);
    if (!begun.ok) throw new Error("refused");
    await begun.guard.submit({ signAndSubmit: async () => ({ success: true, hash: "h" }) }, { needsNonInvokerSigningBy: () => [WALLET] } as never);
    begun.guard.finish("sent");
    await begun.guard.lockFree;
    expect(g.readPastBy(WALLET)).toBe(1000 + g.SEND_LEDGERS);
  });

  it("a confirmed payment whose read-after ledger is refused keeps its record, so another page still reads past it", async () => {
    const kept = storage({ refuseReadAfter: true });
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1000, undefined, 1000);
    if (!begun.ok) throw new Error("refused");
    await begun.guard.submit({ signAndSubmit: async () => ({ success: true, hash: "h", ledger: 1005 }) }, { needsNonInvokerSigningBy: () => [WALLET] } as never);
    begun.guard.finish("sent");
    await begun.guard.lockFree;
    expect(kept.has(KEY)).toBe(true);
    expect(g.readPastBy(WALLET) ?? 0).toBeGreaterThanOrEqual(1004);
  });

  it("control: a payment proven not sent removes its record and asks for no read", async () => {
    const kept = storage();
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1000, undefined, 1000);
    if (!begun.ok) throw new Error("refused");
    begun.guard.finish("not-sent");
    await begun.guard.lockFree;
    expect(kept.has(KEY)).toBe(false);
    expect(g.readPastBy(WALLET)).toBe(null);
  });

  it("anchorReceived keeps the received payment's closeBy as the read-after ledger", async () => {
    const kept = storage({ kept: new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 1018, anchorId: "a1", hash: null })]]) });
    const g = await guard();
    await g.anchorReceived(WALLET, "a1");
    expect(kept.has(KEY)).toBe(false);
    expect(g.readPastBy(WALLET)).toBe(1018);
  });

  it("anchorReceived keeps the record when its closeBy cannot be kept as the read-after ledger", async () => {
    const kept = storage({ refuseReadAfter: true, kept: new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 1018, anchorId: "a1", hash: null })]]) });
    const g = await guard();
    await g.anchorReceived(WALLET, "a1");
    expect(kept.has(KEY)).toBe(true);
    expect(g.readPastBy(WALLET)).toBe(1018);
  });

  it("a new payment that replaces a passed record keeps its closeBy as the read-after ledger", async () => {
    storage({ kept: new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 1018, anchorId: "a0", hash: null })]]) });
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1040, undefined, 1040);
    if (!begun.ok) throw new Error("refused");
    begun.guard.finish("not-sent");
    await begun.guard.lockFree;
    expect(g.readPastBy(WALLET)).toBe(1018);
  });

  it("a new payment does not replace a passed record whose closeBy cannot be kept", async () => {
    const kept = storage({ refuseReadAfter: true, kept: new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 1018, anchorId: "a0", hash: null })]]) });
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1040, undefined, 1040);
    expect(begun.ok).toBe(false);
    expect(JSON.parse(kept.get(KEY)!).id).toBe("x");
  });

  it("Send is refused under the lock when the balance on screen is older than a kept read-after ledger", async () => {
    storage({ kept: new Map([[READ_AFTER, "1004"]]) });
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1040, undefined, 1004);
    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.hold.reason).toBe("stale");
  });

  it("control: Send goes ahead under the lock when the balance on screen was read past it", async () => {
    storage({ kept: new Map([[READ_AFTER, "1004"]]) });
    const g = await guard();
    const begun = await g.acquireSend(WALLET, "a1", 1040, undefined, 1005);
    expect(begun.ok).toBe(true);
    if (begun.ok) begun.guard.finish("not-sent");
  });

  it("after the person's check, a record with no closeBy stays when the ledger of that check cannot be kept", async () => {
    const kept = storage({ refuseReadAfter: true, kept: new Map([[KEY, JSON.stringify({ v: 1, id: "old", at: 1 })]]) });
    const g = await guard();
    expect(await g.clearUnknown(WALLET, undefined, 1499)).toBe(false);
    expect(kept.has(KEY)).toBe(true);
  });

  it("after the person's check, the ledger of that check is kept as the read-after ledger", async () => {
    const kept = storage({ kept: new Map([[KEY, JSON.stringify({ v: 1, id: "old", at: 1 })]]) });
    const g = await guard();
    expect(await g.clearUnknown(WALLET, undefined, 1499)).toBe(true);
    expect(kept.has(KEY)).toBe(false);
    expect(g.readPastBy(WALLET)).toBe(1499);
  });
});
