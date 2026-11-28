// Codex tax R4 #1 (2026-11-28): when the cursor stopped moving after a full page that had reached its own newest
// ledger, the reader accepted the following empty page and took ITS newest ledger as covered, though the cursor
// never reached it. With a recheck that repeated events the scan had already read (so nothing looked new), the
// estimate claimed a newer ledger than any scan reached. Now an unmoving cursor must also reach the following page's
// newest ledger, and a recheck (which reads only after the scan's cursor) that returns an event the scan already
// read is refused as an inconsistent answer.
import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, type ChainReader, type EventsPage, type RawEvent } from "../src/lib/tax/chain-payments";
import { CONTRACT, WALLET, chain, cursorFor, payment, unix } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const N = 6000000;
const TIP = N + 5000;
const PAGE_LIMIT = 200;

/** PAGE_LIMIT events the split emits that are not payments (a pot move), at ledgers up to N. */
const moves: RawEvent[] = Array.from({ length: PAGE_LIMIT }, (_, i) => {
  const base = payment("2026-11-27T14:00:00Z", 1_0000000).event;
  const ledger = N - PAGE_LIMIT + 1 + i;
  return { ...base, ledger, id: `${String(ledger).padStart(19, "0")}-0000000001`, topic: [xdr.ScVal.scvSymbol("moved").toXDR("base64"), xdr.ScVal.scvSymbol("v1").toXDR("base64")] };
});

const at = (latestLedger: number, cursorLedger: number, events: RawEvent[] = []): EventsPage => ({
  latestLedger,
  oldestLedger: 5000000,
  latestLedgerCloseTime: unix(latestLedger === TIP ? "2026-11-27T22:00:00Z" : "2026-11-27T14:59:30Z"),
  oldestLedgerCloseTime: unix("2025-12-01T00:00:00Z"),
  events,
  cursor: cursorFor(cursorLedger),
});

/** The scan reads the moves and ends at N; each recheck from N answers `firstRecheck`, then `afterThat` (its cursor may not move). */
function scripted(firstRecheck: EventsPage, afterThat: EventsPage): ChainReader {
  const base = chain([]);
  let calls = 0;
  return {
    ...base,
    // The scan: a full page of the moves, then (from its cursor) nothing more, with the cursor still at N.
    events: async (_c, from) => ("cursor" in from ? at(N, N) : at(N, N, moves)),
    holdings: async () => ({ held: BigInt(0), pots: BigInt(0), ledger: TIP }),
    eventsAfter: async (_c, cursor) => {
      // A recheck starts from the scan's cursor; a second page from the same cursor is that recheck's following page.
      const first = cursor === cursorFor(N) && calls++ % 2 === 0;
      return first ? firstRecheck : afterThat;
    },
  };
}

const outcome = (c: ChainReader) =>
  readSplitPayments(c, want).then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );

describe("Codex tax R4 #1: an unmoving cursor covers only the ledger it reached", () => {
  it("control: a recheck whose empty page reaches the tip covers the tip", async () => {
    const r = await outcome(scripted(at(TIP, TIP), at(TIP, TIP)));
    expect(r.ok && r.v.kind === "read" ? r.v.coverage.toLedger : r).toBe(TIP);
  });

  it("a full recheck page of events already read, then an empty page with the same cursor and a newer tip, does not cover that tip", async () => {
    // Codex's scripted responses: the recheck repeats the scan's events up to N (its cursor stays at N), then
    // answers an empty page with the same cursor whose newest ledger is TIP. No ledger after N was ever scanned.
    const r = await outcome(scripted(at(N, N, moves), at(TIP, N)));
    expect(r.ok && r.v.kind === "read" ? r.v.coverage.toLedger : null).not.toBe(TIP);
    expect(r.ok).toBe(false);
  });

  it("a recheck that returns an event the scan already read is refused, even with no newer ledger", async () => {
    const r = await outcome(scripted(at(N, N, moves.slice(-1)), at(N, N)));
    expect(!r.ok && r.e.message).toMatch(/already sent/);
  });
});
