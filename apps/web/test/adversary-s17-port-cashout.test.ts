// Adversary s17 (found on the split write guard), ported to the cash-out send guard, which reads its record the same
// way: a saved closeBy beyond u32 (Stellar numbers ledgers with a u32 and the kit refuses to sign an expiry beyond
// it, so only damaged or odd storage holds one) was taken as a real closeBy, and the payment hold waited for a ledger
// the network never reaches, with no "I have checked my balance" way past it. It now counts as no closeBy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET } from "./adversary-c2-harness";

const KEY = `caracal.cashout.send.${WALLET}`;

function storage(kept: Map<string, string>) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
  return kept;
}

describe("adversary s17 port: a closeBy no ledger can reach", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("control: the largest u32 closeBy is a real one, held as an earlier payment", async () => {
    storage(new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 0xffff_ffff, anchorId: "a1", hash: null })]]));
    const { sendHold, recordCloseBy } = await import("../src/lib/anchor/send-guard");
    expect(sendHold(WALLET, 1000)).toMatchObject({ held: true, reason: "earlier-send" });
    expect(recordCloseBy(WALLET)).toBe(0xffff_ffff);
  });

  it("a closeBy beyond u32 holds with the person's check as the way past, and that check clears it", async () => {
    const kept = storage(new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 4_294_968_296, anchorId: "a1", hash: null })]]));
    const { sendHold, recordCloseBy, clearUnknown } = await import("../src/lib/anchor/send-guard");
    expect(sendHold(WALLET, 1000)).toMatchObject({ held: true, reason: "unknown-expiry", earlier: { anchorId: "a1" } });
    expect(recordCloseBy(WALLET)).toBeNull();
    expect(await clearUnknown(WALLET)).toBe(true);
    expect(kept.has(KEY)).toBe(false);
    expect(sendHold(WALLET, 1000)).toEqual({ held: false });
  });
});
