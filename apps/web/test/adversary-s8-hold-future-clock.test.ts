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
// Rewritten with Codex split R3 (disclosed in docs/decisions.md): the hold no longer reads the clock at all,
// so its promise is restated in ledgers: a write is held until the network passes its closeBy, and a clock set
// back or forward changes nothing (s8 proved a clock set back held it too long; Codex R3 proved one set forward
// released it too early).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WRITE_LEDGERS, beginWrite, holdOn, holdText } from "../src/lib/split/write-guard";
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("adversary s8: a changed clock", () => {
  it("control: held up to closeBy, lifted past it", () => {
    stubStorage();
    const begun = beginWrite(SPLIT, 1000);
    if (!begun.ok) throw new Error("the write should start");
    begun.guard.finish({ kind: "unknown", message: "no answer" });
    expect(holdOn(SPLIT, 1000 + WRITE_LEDGERS).held).toBe(true);
    expect(holdOn(SPLIT, 1001 + WRITE_LEDGERS).held).toBe(false);
  });

  it("a clock set back an hour after the write does not hold it past closeBy, and the text names the ledgers left", () => {
    vi.useFakeTimers();
    const real = 1_800_000_000_000;
    vi.setSystemTime(real + 60 * MIN); // the device clock was an hour fast when it wrote
    stubStorage();
    const begun = beginWrite(SPLIT, 1000);
    if (!begun.ok) throw new Error("the write should start");
    begun.guard.finish({ kind: "unknown", message: "no answer" });
    vi.setSystemTime(real); // corrected
    const first = holdOn(SPLIT, 1000 + WRITE_LEDGERS - 11, real);
    expect(first.held).toBe(true);
    expect(first.held && holdText(first, real)).toMatch(/about 1 minute/);
    expect(holdOn(SPLIT, 1001 + WRITE_LEDGERS, real).held).toBe(false);
  });
});
