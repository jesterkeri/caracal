// Adversary t8: the estimate states one ledger it covers ("Covers payments your split contract recorded through
// ledger N", docs/decisions.md 2026-11-27 "The estimate states one ledger it covers"; chain-payments.ts says the
// events and the holdings "agree up to that ledger"). The holdings (USDC the contract holds above its pots, which
// arrived without a recorded payment) are read BEFORE that ledger is fixed by the last events read. USDC sent
// straight to the contract (no event, so the event re-read cannot see it) in a ledger after the holdings read and
// at or before the covered ledger is inside the claimed coverage and unchecked.
//
// The chain here is a fake with a ledger clock: every call advances it by one ledger, and a direct USDC transfer
// (the contract holds 1 unit more than its pots, no event) lands in ledger TRANSFER. Answers are in the real RPC
// shapes used by adversary-t1-harness.ts. No network.
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, type ChainReader, type Retention } from "../src/lib/tax/chain-payments";
import { CONTRACT, WALLET, cursorFor, unix } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const START = 6_000_000;

/** A chain with no events at all, whose newest ledger advances by one per call; a direct transfer lands in ledger `transfer`. */
function chainWithDirectTransfer(transfer: number): { reader: ChainReader; log: string[] } {
  let clock = START;
  const log: string[] = [];
  const retention = (): Retention => ({
    latestLedger: clock,
    oldestLedger: 5_000_000,
    latestLedgerCloseTime: unix("2026-11-27T14:59:30Z"),
    oldestLedgerCloseTime: unix("2025-12-01T00:00:00Z"),
  });
  const call = <T>(name: string, f: () => T): Promise<T> => {
    clock++;
    log.push(`${name}@${clock}`);
    return Promise.resolve(f());
  };
  const reader: ChainReader = {
    health: () => call("health", retention),
    instance: () => call("instance", () => ({ kind: "wasm" as const, hash: SPLIT.wasmHash })),
    events: () => call("events", () => ({ ...retention(), events: [], cursor: cursorFor(clock) })),
    eventsAfter: () => call("eventsAfter", () => ({ ...retention(), events: [], cursor: cursorFor(clock) })),
    // The contract holds 1 unit more than its pots from the ledger the direct transfer landed in.
    holdings: () => call("holdings", () => ({ held: BigInt(clock >= transfer ? 1 : 0), pots: BigInt(0), ledger: clock })),
    transaction: async () => {
      throw new Error("no transactions in this chain");
    },
  };
  return { reader, log };
}

describe("the holdings are read at the covered ledger, not before it", () => {
  it("control: USDC that arrived before the holdings read refuses (the harness works)", async () => {
    // Calls: health 1, instance 2, events 3, holdings 4. A transfer in ledger 4 is seen by the holdings read.
    const { reader } = chainWithDirectTransfer(START + 4);
    await expect(readSplitPayments(reader, want)).rejects.toThrow(/more USDC than its tax, goal and spend pots/);
  });

  it("control: USDC that arrives long after the covered ledger is not in the estimate and is not claimed", async () => {
    const { reader } = chainWithDirectTransfer(START + 100);
    const r = await readSplitPayments(reader, want);
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect(r.coverage.toLedger).toBeLessThan(START + 100);
  });

  it("DEFECT: USDC sent straight to the contract inside the covered ledgers, after the holdings read, is neither seen nor excluded", async () => {
    // Calls: health 1, instance 2, events 3, holdings 4 (still balanced), eventsAfter 5 (the covered ledger).
    // The direct transfer lands in ledger 5: at or before the covered ledger, after the holdings read.
    const { reader, log } = chainWithDirectTransfer(START + 5);
    const outcome = await readSplitPayments(reader, want).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    // Either the read refuses (the transfer was noticed), or it must not claim coverage through a ledger in which
    // USDC arrived that no payment explains.
    if (outcome.ok && outcome.r.kind === "read") {
      expect(outcome.r.coverage.toLedger, `calls: ${log.join(" ")}`).toBeLessThan(START + 5);
    }
  });
});
