// A check settles an attempt by its last ledger, from two storage reads made outside the lock (the ledger, then the
// id), which another tab can interleave with: it could pair an earlier attempt's ledger with a newer attempt's id,
// and then remove the newer record (adversary i22, suspicion). endAttempt with `by` removes the record only when it
// still has that ledger. Real: attempt.ts and the shared Web Locks stand-in. Faked: localStorage (a Map).
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function storage(kept: Map<string, string>) {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    },
  });
}

const KEY = "caracal.payPending.CSPLIT.ab";

describe("endAttempt with the ledger a check settled", () => {
  it("leaves a record whose ledger is not the one the check settled, even with the same id", async () => {
    const kept = new Map<string, string>();
    storage(kept);
    const g = await import("../src/lib/invoices/attempt");
    const slot = g.paySlot("CSPLIT", "ab");
    const a = await g.beginAttempt(slot, 2060);
    if (!a.ok) throw new Error("refused");
    // The check read the earlier attempt's ledger (1060) with this attempt's id.
    expect(await g.endAttempt(slot, a.attempt.id, undefined, 1060)).toBe(true);
    expect(kept.get(KEY)).toBe("2060");
  });

  it("control: removes the record when the id and the ledger both match", async () => {
    const kept = new Map<string, string>();
    storage(kept);
    const g = await import("../src/lib/invoices/attempt");
    const slot = g.paySlot("CSPLIT", "ab");
    const a = await g.beginAttempt(slot, 2060);
    if (!a.ok) throw new Error("refused");
    expect(await g.endAttempt(slot, a.attempt.id, undefined, 2060)).toBe(true);
    expect(kept.has(KEY)).toBe(false);
  });
});
