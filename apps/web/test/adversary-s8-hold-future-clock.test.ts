// Adversary s8: a write-guard record dated in the future holds every write for
// as long as the clock is behind it, not for 3 minutes.
//
// src/lib/split/write-guard.ts read(): "A renewal time in the future (a changed
// clock) counts as now, so it cannot hold forever." The record is only read as
// `Math.min(beat, now)`: it is never rewritten, so on every later read its
// beat is clamped to that read's `now` again. `now - beat` stays 0 and the hold
// never reaches SETTLE_MS until the real clock catches up with the stored beat.
// A device whose clock is stepped back by an hour (NTP, a corrected wrong time,
// a resumed VM) after a write whose outcome was unknown keeps every split write
// blocked for an hour and three minutes, and the page keeps saying "for about 3
// minutes" the whole time (holdText, until = beat + SETTLE_MS = now + 3 min).
//
// Spec:
// - attacker goal 5: "a hold that never lifts";
// - write-guard.ts header: "SETTLE_MS is 3 minutes after the last renewal";
// - write-guard.ts read(): the sentence quoted above.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTLE_MS, beginWrite, holdOn, holdText } from "../src/lib/split/write-guard";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);
const MIN = 60_000;

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("adversary s8: a record dated in the future", () => {
  it("control: a record from 4 minutes ago has lifted, and one from 1 minute ago holds", () => {
    stubStorage();
    const T = 1_800_000_000_000;
    const begun = beginWrite(SPLIT, () => T);
    if (!begun.ok) throw new Error("the write should start");
    begun.guard.finish({ kind: "unknown", message: "no answer" });
    expect(holdOn(SPLIT, T + MIN).held).toBe(true);
    expect(holdOn(SPLIT, T + SETTLE_MS + MIN).held).toBe(false);
  });

  it("a write recorded while the clock was an hour ahead is held for 3 minutes once the clock is right, not for an hour", () => {
    stubStorage();
    const real = 1_800_000_000_000;
    const ahead = real + 60 * MIN;
    const begun = beginWrite(SPLIT, () => ahead); // the device clock was an hour fast when it wrote
    if (!begun.ok) throw new Error("the write should start");
    begun.guard.finish({ kind: "unknown", message: "no answer" }); // renewed at `ahead`
    // The clock is corrected. First read: the record counts as written now.
    const first = holdOn(SPLIT, real);
    expect(first.held).toBe(true);
    expect(first.held && holdText(first, real)).toMatch(/about 3 minutes/);
    // Four minutes later nothing has been renewed (no write pending in this tab): the hold must have lifted.
    const later = holdOn(SPLIT, real + SETTLE_MS + MIN);
    // Defect: still held, with the same "about 3 minutes" text, until `ahead` + 3 minutes.
    expect(later.held).toBe(false);
  });
});
