// The cash-out send guard bounded by ledgers, not by the browser's clock (the same finding as Codex split R3,
// fixed here before the cash-out R2 review), and adversary c27 (the page offered "Start another cash-out" while
// the guard still refused it; kept as test/adversary-c27-hold-after-offered-another.test.ts).
// The guard's API changed with the fix, from a clock to a ledger, so these run against the new API only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIT_DEFAULT_LEDGERS, SEND_LEDGERS, UnboundedPayment, anchorReceived, beginSend, readLedger, sendHold } from "../src/lib/anchor/send-guard";
import { sendToAnchor } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { WALLET, clickButton, fixture, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const KEY = `caracal.cashout.send.${WALLET}`;
const HOUR = 3_600_000;

function storage(kept = new Map<string, string>()) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
  return kept;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the cash-out hold: no clock decides when a payment can no longer land", () => {
  it("a clock jumped an hour forward after an unknown payment does not release it before closeBy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    storage();
    const begun = beginSend(WALLET, "a1", 1000);
    if (!begun.ok) throw new Error("should begin");
    begun.guard.finish("unknown");
    vi.setSystemTime(1_800_000_000_000 + HOUR);
    expect(sendHold(WALLET, 1001).held).toBe(true);
    expect(beginSend(WALLET, "a2", 1001).ok).toBe(false);
    expect(sendHold(WALLET, 1000 + SEND_LEDGERS).held).toBe(true);
    expect(sendHold(WALLET, 1001 + SEND_LEDGERS).held).toBe(false);
  });

  it("a record from the older, clock-based version is held past the kit's default expiry, and still names the anchor transaction", () => {
    const kept = storage();
    kept.set(KEY, JSON.stringify({ id: "old", beat: Date.now() - HOUR, anchorId: "a1", hash: null }));
    const first = sendHold(WALLET, 2000);
    expect(first).toMatchObject({ held: true, reason: "earlier-send", earlier: { anchorId: "a1" } });
    expect(sendHold(WALLET, 2000 + KIT_DEFAULT_LEDGERS).held).toBe(true);
    expect(sendHold(WALLET, 2001 + KIT_DEFAULT_LEDGERS).held).toBe(false);
  });

  it("the anchor reporting the withdrawal received removes only that withdrawal's record", () => {
    const kept = storage();
    const begun = beginSend(WALLET, "a1", 1000);
    if (!begun.ok) throw new Error("should begin");
    begun.guard.finish("unknown");
    anchorReceived(WALLET, "other");
    expect(kept.has(KEY)).toBe(true);
    anchorReceived(WALLET, "a1");
    expect(kept.has(KEY)).toBe(false);
    expect(sendHold(WALLET, 1001).held).toBe(false);
  });

  it("a payment that needs no signature from the wallet is not sent, and says nothing was sent", async () => {
    storage();
    const begun = beginSend(WALLET, "a1", 1000);
    if (!begun.ok) throw new Error("should begin");
    const signAndSubmit = vi.fn();
    await expect(begun.guard.submit({ signAndSubmit }, { needsNonInvokerSigningBy: () => [] } as never)).rejects.toBeInstanceOf(UnboundedPayment);
    expect(signAndSubmit).not.toHaveBeenCalled();
    // Through the real flow, with the anchor's real waiting record: the refusal is "not sent", never "unknown".
    const waiting = parseTransaction(JSON.parse(fixture("txn-pending-user-transfer-start.json")));
    const r = await sendToAnchor(waiting, BigInt(20_000_000), {
      buildTransfer: async () => ({}),
      signAndSubmit: (tx) => begun.guard.submit({ signAndSubmit }, Object.assign(tx as object, { needsNonInvokerSigningBy: () => [] }) as never),
      stillCurrent: () => null,
    });
    expect(r).toMatchObject({ kind: "not-sent", message: expect.stringMatching(/Nothing was sent/) });
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  it("readLedger refuses an answer without a ledger number", async () => {
    await expect(readLedger({ getLatestLedger: async () => ({ sequence: 77 }) })).resolves.toBe(77);
    await expect(readLedger({ getLatestLedger: async () => ({}) })).rejects.toThrow(/did not say which ledger/);
  });
});

describe("the cash-out page", () => {
  afterEach(() => unmock());

  it("a Send whose ledger cannot be read sends nothing and says so", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const submit = vi.fn(async () => ({ success: true, hash: "cb".repeat(32) }));
    let fail = false;
    const rpc = {
      getLatestLedger: async () => {
        if (fail) throw new Error("down");
        return { sequence: 100 };
      },
    };
    const { rt, world } = await mount({ store: new Map(), submit, rpc });
    await toConfirm(rt, world);
    fail = true;
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(submit).not.toHaveBeenCalled();
    expect(text(rt)).toMatch(/could not read the Stellar network, so nothing was sent/);
    rt.unmount();
  });
});

// The split guard's adversary s11, ported: a payment whose kit call never settles kept the wallet's lock.
describe("the lock of a payment whose kit call never settles", () => {
  it("holds through closeBy and is let go once the network passes it", async () => {
    storage();
    const { acquireSend } = await import("../src/lib/anchor/send-guard");
    const first = await acquireSend(WALLET, "a1", 1000);
    if (!first.ok) throw new Error("should begin");
    void first.guard.submit({ signAndSubmit: () => new Promise<never>(() => {}) }, { needsNonInvokerSigningBy: () => [WALLET] } as never);
    first.guard.finish("unknown");
    expect((await acquireSend(WALLET, "a2", 1000 + SEND_LEDGERS)).ok).toBe(false);
    const second = await acquireSend(WALLET, "a2", 1001 + SEND_LEDGERS);
    expect(second.ok).toBe(true);
    if (second.ok) second.guard.finish("sent");
  });

  it("a payment released just now does not refuse the next one while its lock is being let go", async () => {
    storage();
    const { acquireSend } = await import("../src/lib/anchor/send-guard");
    const first = await acquireSend(WALLET, "a1", 1000);
    if (!first.ok) throw new Error("should begin");
    first.guard.finish("not-sent");
    const second = await acquireSend(WALLET, "a2", 1000);
    expect(second.ok).toBe(true);
    if (second.ok) second.guard.finish("sent");
  });
});
