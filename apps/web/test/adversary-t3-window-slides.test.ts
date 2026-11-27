// Adversary t3: the public RPC's retention window is a fixed number of ledgers
// (120960 on testnet), so its `oldestLedger` rises by one with every ledger
// that closes, about every 5 seconds (fixtures/tax/soroban-testnet-split-events.json:
// ledgerRetentionWindow 120960; a real getEvents page there stops at ledger
// 5932999 while the newest is 5953058, so a read is at least two requests).
// readSplitPayments refuses ("The RPC's history window moved while Caracal was
// reading it") when a LATER page reports an oldestLedger above where reading
// began. But events from the start ledger up to the cursor were already read;
// the window sliding forward cannot remove them, so nothing is missing and the
// refusal is not needed for pages after the first. A read that spans one ledger
// close (about 5 s, two requests) is refused for a fact that is proven.
// Chain answers are CONSTRUCTED in the real Soroban RPC wire format.
import { describe, expect, it } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, type EventsPage } from "../src/lib/tax/chain-payments";
import { SPLIT } from "../src/lib/stellar/config";
import { WALLET, CONTRACT, chain, cursorFor, payment, unix } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };

const WINDOW_START = "2026-11-20T14:15:35Z";

function twoPages(secondOldest: number) {
  const item = payment("2026-11-25T21:17:43Z", 10_000_000_000);
  const base = chain([item], WINDOW_START);
  const retention = { latestLedger: 6000000, oldestLedger: 5000000, latestLedgerCloseTime: unix("2026-11-27T14:59:30Z"), oldestLedgerCloseTime: unix(WINDOW_START) };
  let calls = 0;
  return {
    ...base,
    // First request: start of the window, the payment, and a cursor short of the newest ledger.
    // Second request (by cursor): nothing more, up to the newest ledger, and the window has slid.
    events: async (): Promise<EventsPage> => {
      calls++;
      return calls === 1
        ? { ...retention, events: [item.event], cursor: cursorFor(5950000) }
        : { ...retention, oldestLedger: secondOldest, events: [], cursor: cursorFor(6000000) };
    },
  };
}

describe("adversary t3: the retention window slides while a read is in progress", () => {
  it("control: no slide, two pages, the payment is read", async () => {
    const r = await readSplitPayments(twoPages(5000000), want);
    expect(r.kind === "read" && r.payments).toHaveLength(1);
  });

  it("control: a first page that already starts after the ledger asked for is still refused", async () => {
    const c = chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], WINDOW_START);
    const retention = { latestLedger: 6000000, oldestLedger: 5000001, latestLedgerCloseTime: unix("2026-11-27T14:59:30Z"), oldestLedgerCloseTime: unix(WINDOW_START) };
    await expect(readSplitPayments({ ...c, events: async () => ({ ...retention, events: [], cursor: cursorFor(6000000) }) }, want)).rejects.toThrow(/moved/);
  });

  it("a second page that reports the window one ledger further on (one ledger closed in between) does not discard what was already read", async () => {
    const r = await readSplitPayments(twoPages(5000001), want);
    expect(r.kind === "read" && r.payments).toHaveLength(1);
  });
});
