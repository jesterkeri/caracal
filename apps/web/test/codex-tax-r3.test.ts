// Codex tax R3 (2026-11-28): the recheck after the scan read one page and took its newest ledger as covered,
// without checking that its cursor had reached that ledger. Stellar RPC can answer a sparse or empty page that
// stops short of the newest ledger (it scans a capped range per request), so a payment in the rest of the range
// was left out while the estimate claimed to cover it. Each recheck now pages on until its cursor reaches the
// newest ledger it names.
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, type ChainReader, type EventsPage } from "../src/lib/tax/chain-payments";
import { CONTRACT, WALLET, chain, cursorFor, payment, unix } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const N = 6000000;
const TIP = N + 20000;
const page = (cursorLedger: number, events: EventsPage["events"] = []): EventsPage => ({
  latestLedger: TIP,
  oldestLedger: 5000000,
  latestLedgerCloseTime: unix("2026-11-27T14:59:40Z"),
  oldestLedgerCloseTime: unix("2025-12-01T00:00:00Z"),
  events,
  cursor: cursorFor(cursorLedger),
});

/** The scan ends at N; every recheck from there answers an empty page that stops at N + 10000, then `rest`. */
function capped(rest: EventsPage): ChainReader & { calls: string[] } {
  const base = chain([]);
  const calls: string[] = [];
  return {
    ...base,
    calls,
    holdings: async () => ({ held: BigInt(0), pots: BigInt(0), ledger: TIP }),
    eventsAfter: async (_c, cursor) => {
      calls.push(cursor);
      return cursor === cursorFor(N) ? page(N + 10000) : rest;
    },
  };
}

describe("Codex tax R3: a recheck covers only ledgers its cursor reached", () => {
  it("control: an empty capped page, then an empty page that reaches the tip, covers the tip", async () => {
    const c = capped(page(TIP));
    const r = await readSplitPayments(c, want);
    expect(r.kind === "read" && r.coverage.toLedger).toBe(TIP);
    expect(c.calls).toContain(cursorFor(N + 10000)); // it read on from where the capped page stopped
  });

  it("an empty capped page followed by a payment before the tip is not taken as covering the tip without that payment", async () => {
    const late = payment("2026-11-27T14:59:00Z", 50_0000000).event;
    const c = capped(page(TIP, [{ ...late, ledger: N + 15000 }]));
    const r = await readSplitPayments(c, want).then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e }),
    );
    // Before R3: read, covering TIP, without the payment at N + 15000.
    expect(r.ok && r.v.kind === "read" ? r.v.coverage.toLedger : null).not.toBe(TIP);
    expect(!r.ok && r.e.message).toMatch(/kept arriving/);
  });

  it("a recheck whose cursor stops moving short of the tip is refused, not taken as covering it", async () => {
    const c = capped(page(N + 10000));
    await expect(readSplitPayments(c, want)).rejects.toThrow(/stopped moving/);
  });
});
