// Adversary s21: a new write that replaces a passed record drops that record's closeBy for good.
//
// An unknown write's record is removed by clearPassed, which first keeps its closeBy as the ledger the pots must be
// read past (write-guard.ts `rememberReadAfter`, adversary s20), so a page opened later still gates its first read.
// But beginWrite also removes a passed record: "a new write replaces a passed record" (decisions, Codex split R4 #1),
// by overwriting the same key, and it does not keep the old closeBy anywhere. When that new write then ends with a
// certain outcome that sets no read-past ledger of its own (stopped: the passkey prompt was closed; refused), nothing
// in this browser remembers the earlier unknown write. A page opened afterwards, whose first read comes from an RPC
// node behind that write's closeBy, shows the pots from before it with every write offered (the s20 hole).
//
// Spec: write-guard.ts header ("A passed record does not let the page act at once: the pots must first be read at a
// ledger past its closeBy"), `readAfter` doc ("kept in this browser, so a page opened later (a reload, another tab)
// still gates its first read"), docs/decisions.md Adversary s20, session goal 2.
//
// The route in: the poll that runs clearPassed is a 5 s timer (throttled to once a minute in a background tab); a click
// on Withdraw after a Refresh that read past closeBy, before the next tick, starts the new write under the lock while the
// passed record is still there. This test drives the guard directly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPLIT } from "./s4-fake-network";

const KEY = `caracal.split.write.${SPLIT}`;
const CLOSE_BY = 1060;
function storage(kept = new Map<string, string>()) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
  return kept;
}

describe("adversary s21: the closeBy of an earlier unknown write after a new write replaced its record", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("control: clearPassed removes the passed record and keeps its closeBy as the ledger the pots must be read past", async () => {
    storage(new Map([[KEY, JSON.stringify({ v: 2, id: "earlier", closeBy: CLOSE_BY })]]));
    const { clearPassed, readPastBy } = await import("../src/lib/split/write-guard");
    await clearPassed(SPLIT, CLOSE_BY + 40);
    expect(readPastBy(SPLIT)).toBe(CLOSE_BY);
  });

  it("a new write replaces the passed record and ends 'stopped': a page opened afterwards must still be asked to read past the earlier write's closeBy", async () => {
    const kept = storage(new Map([[KEY, JSON.stringify({ v: 2, id: "earlier", closeBy: CLOSE_BY })]]));
    const { beginWrite, readPastBy } = await import("../src/lib/split/write-guard");
    const begun = beginWrite(SPLIT, CLOSE_BY + 40); // the network is past the earlier write's closeBy: this write may start
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    begun.guard.finish({ kind: "stopped", message: "The passkey prompt was closed or timed out." });
    expect(kept.has(KEY)).toBe(false); // the new write's record is gone, as it should be
    // A fresh page (a reload, another tab) asks the guard which ledger its pots must be read past.
    const gate = readPastBy(SPLIT);
    expect(gate ?? 0, `readPastBy is ${gate}: nothing in this browser remembers the earlier unknown write whose record was replaced`).toBeGreaterThanOrEqual(CLOSE_BY);
  });
});
