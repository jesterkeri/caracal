// Codex split R6 (REVISE, 1 finding, P1): passLedger lets go of an earlier write's lock once the network passes its
// closeBy, while its kit call may still be waiting. When that result came in later, finish() kept the read-after
// ledger and removed the record without the lock, and rememberReadAfter's read-then-write is not atomic across tabs:
// the late result could read the old ledger, another tab could start and finish a newer write and keep a later one,
// and the late result then wrote its earlier ledger over it. A page could then accept pots read between the two.
// Now a finish that comes after its lock was let go writes nothing: the record, if still its own, gates every page
// with its closeBy (never earlier than the ledger the late result would keep), and clearPassed removes it under the
// lock, keeping that closeBy; a record already replaced or cleared had its closeBy kept under the lock.
//
// Real: the guard. Faked: localStorage (a Map, with another tab's writes injected at a chosen moment), the kit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);
const KEY = `caracal.split.write.${SPLIT}`;
const READ_AFTER = `caracal.split.readAfter.${SPLIT}`;
const START = 1000;
const LANDED = 1005;
/** The read-after ledger another tab's newer write keeps. */
const NEWER = 1999;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Storage shared with another tab: `between` runs once, the first time this tab reads the read-after ledger after
 * `arm`, or at `flush` when this tab never read it (the other tab acts either way).
 */
function storage() {
  const kept = new Map<string, string>();
  let armed: (() => void) | null = null;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => {
        const v = kept.get(k) ?? null;
        if (k === READ_AFTER && armed) {
          const run = armed;
          armed = null;
          run();
        }
        return v;
      },
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    },
  });
  const flush = () => {
    const run = armed;
    armed = null;
    run?.();
  };
  return { kept, arm: (between: () => void) => (armed = between), flush };
}

/** A write whose kit call is still waiting when the network passes its closeBy, so passLedger lets go of its lock. */
async function lateWrite() {
  const g = await import("../src/lib/split/write-guard");
  const begun = await g.acquireWrite(SPLIT, START, undefined, START);
  if (!begun.ok) throw new Error("refused");
  const kit = begun.guard.kit({ signAndSubmit: () => new Promise(() => {}) } as never);
  void (kit as unknown as { signAndSubmit(tx: unknown): Promise<unknown> }).signAndSubmit({ needsNonInvokerSigningBy: () => [WALLET] });
  await g.passLedger(SPLIT, begun.guard.closeBy + 1);
  return { g, guard: begun.guard };
}

describe("Codex split R6: a result that comes in after its write's lock was let go never lowers the read-after ledger", () => {
  it("another tab's newer write ends while the late result is being kept: its later read-after ledger stays", async () => {
    const { kept, arm, flush } = storage();
    const { g, guard } = await lateWrite();
    expect(kept.has(KEY)).toBe(true);
    // The other tab, holding the lock now free: it replaces the passed record (keeping its closeBy) and its own
    // confirmed write then ends, keeping a later ledger and removing its record.
    arm(() => {
      kept.delete(KEY);
      kept.set(READ_AFTER, JSON.stringify(NEWER));
    });
    guard.finish({ kind: "done", hash: "a".repeat(64), ledger: LANDED });
    flush();
    expect(g.readAfter(SPLIT)).toBe(NEWER);
    expect(g.readPastBy(SPLIT)).toBe(NEWER);
  });

  it("a late confirmed result leaves its own record, which gates every page until clearPassed keeps its closeBy under the lock", async () => {
    const { kept } = storage();
    const { g, guard } = await lateWrite();
    guard.finish({ kind: "done", hash: "a".repeat(64), ledger: LANDED });
    expect(kept.has(KEY)).toBe(true);
    expect(g.readPastBy(SPLIT) ?? 0).toBeGreaterThanOrEqual(LANDED - 1);
    await g.clearPassed(SPLIT, guard.closeBy + 1);
    expect(kept.has(KEY)).toBe(false);
    expect(g.readAfter(SPLIT)).toBe(guard.closeBy);
  });

  it("control: a confirmed result while the write still holds its lock keeps the landed ledger less one and removes the record", async () => {
    const { kept } = storage();
    const g = await import("../src/lib/split/write-guard");
    const begun = await g.acquireWrite(SPLIT, START, undefined, START);
    if (!begun.ok) throw new Error("refused");
    begun.guard.finish({ kind: "done", hash: "a".repeat(64), ledger: LANDED });
    await begun.guard.lockFree;
    expect(kept.has(KEY)).toBe(false);
    expect(g.readAfter(SPLIT)).toBe(LANDED - 1);
  });
});
