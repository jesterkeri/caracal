// Adversary s24: a model check of the write guard (lib/split/write-guard.ts) across two tabs of one browser.
//
// Random sequences of: the network moving on, a write starting (acquireWrite, in either tab, with the ledger the pots on
// screen were read at), a write ending (done with or without the ledger the kit says, refused, stopped, unknown), the
// poll's clearPassed, and storage refusing the read-after key, the record key or removals. A fixed pseudo-random seed
// drives each run, so a failure replays.
//
// Spec (what must hold, whatever the sequence), from the header of write-guard.ts and decisions 2026-11-28 (Codex split
// R3, R4, R5, adversary s15, s19, s20, s21):
//   1. A write starts only when every earlier write of this split that may still land (being sent, or ended unknown) has
//      its closeBy passed by the ledger the new write was started at: never two writes that can land at once.
//   2. A write starts only on pots read past every earlier write that went through (the ledger it landed in, less one,
//      or its closeBy when the kit did not say) or ended unknown (its closeBy): never a write offered on pots from before
//      an earlier write.
// This is a control against regressions: it passes on 32bd399 (no defect was found by it), and the coverage check makes
// sure the sequences do reach successful starts, stale refusals and storage refusals, so a pass is not vacuous.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPLIT } from "./s4-fake-network";
import type { WriteGuard } from "../src/lib/split/write-guard";

const KEY = `caracal.split.write.${SPLIT}`;
const AFTER = `caracal.split.readAfter.${SPLIT}`;

/** A small deterministic generator (LCG), so a failing seed replays. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Status = "inflight" | "unknown" | "done" | "none";
type Write = { guard: WriteGuard; closeBy: number; status: Status; landed?: number };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the write guard, over random sequences in two tabs", () => {
  it("never starts a write while an earlier one can land, or on pots older than an earlier write", async () => {
    const seen = { ok: 0, stale: 0, unreadable: 0, earlier: 0 };
    for (let seed = 1; seed <= 250; seed++) {
      vi.resetModules();
      const r = rng(seed);
      const kept = new Map<string, string>();
      const fail = { after: false, key: false, remove: false };
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (k: string) => kept.get(k) ?? null,
          setItem: (k: string, v: string) => {
            if ((k === AFTER && fail.after) || (k === KEY && fail.key)) throw new Error("quota");
            kept.set(k, v);
          },
          removeItem: (k: string) => {
            if (fail.remove) throw new Error("refused");
            kept.delete(k);
          },
        },
      });
      // Two module instances are two tabs: each has its own live writes, and they share the storage and the Web Locks.
      const tab1 = await import("../src/lib/split/write-guard");
      vi.resetModules();
      const tab2 = await import("../src/lib/split/write-guard");
      const tabs = [tab1, tab2];
      const locks = (globalThis.navigator as unknown as { locks: Parameters<typeof tab1.acquireWrite>[2] }).locks;
      let ledger = 1000;
      const writes: Write[] = [];
      const log: string[] = [];
      try {
        for (let step = 0; step < 60; step++) {
          const op = Math.floor(r() * 7);
          if (op === 0) {
            ledger += Math.floor(r() * 50);
            log.push(`network at ${ledger}`);
          } else if (op === 1 || op === 2) {
            const shownAt = r() < 0.1 ? null : ledger - Math.floor(r() * 80) + Math.floor(r() * 10);
            log.push(`start at ${ledger}, pots read at ${shownAt}, refusing ${JSON.stringify(fail)}`);
            const res = await tabs[Math.floor(r() * 2)]!.acquireWrite(SPLIT, ledger, locks, shownAt);
            if (res.ok) {
              seen.ok++;
              for (const w of writes) {
                if (w.status === "inflight" || w.status === "unknown") {
                  expect(w.closeBy < ledger, `seed ${seed}: started while an earlier write (closeBy ${w.closeBy}) could still land: ${log.join(" | ")}`).toBe(true);
                }
                const gate = w.status === "done" ? (w.landed !== undefined ? w.landed - 1 : w.closeBy) : w.status === "unknown" ? w.closeBy : null;
                if (gate !== null) {
                  expect(shownAt !== null && shownAt > gate, `seed ${seed}: started on pots read at ${shownAt}, not past ${gate}: ${log.join(" | ")}`).toBe(true);
                }
              }
              // A write the network passed is no longer being sent: it can only have ended unknown.
              for (const w of writes) if (w.status === "inflight" && w.closeBy < ledger) w.status = "unknown";
              writes.push({ guard: res.guard, closeBy: res.guard.closeBy, status: "inflight" });
            } else if (res.hold.reason === "stale") seen.stale++;
            else if (res.hold.reason === "unreadable") seen.unreadable++;
            else seen.earlier++;
          } else if (op === 3 || op === 4) {
            const open = writes.filter((w) => w.status === "inflight" && w.closeBy >= ledger);
            if (open.length === 0) continue;
            const w = open[Math.floor(r() * open.length)]!;
            const k = r();
            if (k < 0.4) {
              const landed = r() < 0.7 ? ledger - Math.floor(r() * Math.min(5, ledger - (w.closeBy - 60))) : undefined;
              log.push(`write ended done, landed ${landed}, refusing ${JSON.stringify(fail)}`);
              w.guard.finish({ kind: "done", hash: "h", ledger: landed });
              w.status = "done";
              w.landed = landed;
            } else if (k < 0.6) {
              log.push("write ended refused");
              w.guard.finish({ kind: "refused", message: "Nothing was sent" });
              w.status = "none";
            } else if (k < 0.8) {
              log.push("write ended stopped");
              w.guard.finish({ kind: "stopped", message: "closed" });
              w.status = "none";
            } else {
              log.push("write ended unknown");
              w.guard.finish({ kind: "unknown", message: "no answer" });
              w.status = "unknown";
            }
          } else if (op === 5) {
            log.push(`poll clears passed at ${ledger}`);
            await tabs[Math.floor(r() * 2)]!.clearPassed(SPLIT, ledger, locks);
          } else {
            fail.after = r() < 0.3;
            fail.key = r() < 0.15;
            fail.remove = r() < 0.15;
            log.push(`storage now ${JSON.stringify(fail)}`);
          }
        }
      } finally {
        // Let go of the Web Lock this run's last in-flight write holds, as the next run starts a fresh browser.
        for (const w of writes) if (w.status === "inflight") w.guard.finish({ kind: "refused", message: "Nothing was sent" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    // Control: the runs did start writes, did refuse on stale pots and on storage, so the checks above were exercised.
    expect(seen.ok).toBeGreaterThan(200);
    expect(seen.stale).toBeGreaterThan(100);
    expect(seen.unreadable).toBeGreaterThan(10);
    expect(seen.earlier).toBeGreaterThan(100);
  }, 30_000); // 250 seeded sequences take about 3 s alone; the default 5 s timed out under a loaded full suite
});
