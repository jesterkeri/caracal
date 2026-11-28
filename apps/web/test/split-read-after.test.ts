// Adversary s20 follow-up, at the guard: the ledger the pots must be read past is kept in this browser after a write's
// record is gone, only ever raised, and a kept value that is not a ledger is ignored.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPLIT } from "./s4-fake-network";

const KEY = `caracal.split.write.${SPLIT}`;
const AFTER = `caracal.split.readAfter.${SPLIT}`;
function storage(kept = new Map<string, string>()) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
  return kept;
}

describe("the read-past ledger kept after a write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("clearPassed keeps a passed record's closeBy before removing it", async () => {
    const kept = storage(new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 1060 })]]));
    const { clearPassed, readAfter, readPastBy } = await import("../src/lib/split/write-guard");
    await clearPassed(SPLIT, 1061);
    expect(kept.has(KEY)).toBe(false);
    expect(readAfter(SPLIT)).toBe(1060);
    expect(readPastBy(SPLIT)).toBe(1060);
  });

  it("is only ever raised, and a kept value that is not a ledger is ignored", async () => {
    const kept = storage();
    const { rememberReadAfter, readAfter } = await import("../src/lib/split/write-guard");
    rememberReadAfter(SPLIT, 2000);
    rememberReadAfter(SPLIT, 1500);
    expect(readAfter(SPLIT)).toBe(2000);
    for (const bad of ["2000.5", "-1", "4294968296", '"2000"', "{"]) {
      kept.set(AFTER, bad);
      expect(readAfter(SPLIT)).toBeNull();
    }
  });
});
