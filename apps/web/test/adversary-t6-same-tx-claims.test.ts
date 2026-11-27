// Adversary t6: the check that each payment event agrees with its transaction
// is skipped for every event after the first one that names the same
// transaction hash, so a second event can claim any ledger and any close time
// (any tax day, any CBN rate) and still be valued.
//
// Promise: apps/web/src/lib/tax/chain-payments.ts (readSplitPayments) says "Each
// payment's transaction must be a successful one, in the ledger the event
// names, closed at the time the event names", and the engine values each
// payment at the CBN rate of the Lagos day it arrived (packages/tax/README.md,
// "Rate date rule"). The loop in readSplitPayments checks one event per
// transaction hash (`checked` set), so the day of every later event in that
// hash is never checked against the chain's own transaction record.
//
// Events are CONSTRUCTED in the real RPC wire format by the t1 harness; the
// CBN rates are the real captured rows. The two sources disagree here: the
// event list (getEvents) names a ledger and time for the second event that the
// transaction record (getTransaction) for the same hash contradicts.
import { describe, expect, it } from "vitest";
import { runTaxEstimate } from "../src/lib/tax/pipeline";
import { WALLET, chain, deps, payment, type Item } from "./adversary-t1-harness";

const req = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" as const } };
const REAL_DAY = "2026-11-25T10:00:00Z"; // Wednesday, rate 1392.2481
const CLAIMED_DAY = "2026-11-26T10:00:00Z"; // the day the lying event names, rate 1387.8883

/** `second` rewritten to claim the same transaction hash as `first`, but its own ledger and close time. */
function sameHashOtherClaims(first: Item, second: Item): Item {
  return { event: { ...second.event, txHash: first.event.txHash }, tx: first.tx };
}

describe("adversary t6: events that share a transaction hash are all checked against the transaction", () => {
  it("control: a single event whose close time disagrees with its transaction is refused", async () => {
    const honest = payment(REAL_DAY, 10_000_000_000);
    const lying = { event: { ...honest.event, ledgerClosedAt: CLAIMED_DAY }, tx: honest.tx };
    const out = await runTaxEstimate(req, deps(chain([lying])));
    expect(out.status).toBe("unavailable");
    expect(out.status === "unavailable" ? out.message : "").toMatch(/could not be confirmed/);
  });

  it("control: the same disagreement listed first is refused whichever event is lying", async () => {
    const a = payment(REAL_DAY, 10_000_000_000);
    const b = sameHashOtherClaims(a, payment(CLAIMED_DAY, 5_000_000_000));
    // The lying event comes first, so it is the one the transaction is checked against.
    const out = await runTaxEstimate(req, deps(chain([b, a])));
    expect(out.status).toBe("unavailable");
  });

  it("refuses a second event that names the same transaction hash with another ledger and day", async () => {
    const a = payment(REAL_DAY, 10_000_000_000);
    const b = sameHashOtherClaims(a, payment(CLAIMED_DAY, 5_000_000_000));
    // The chain's record for this hash: ledger and time of `a`. `b` claims a different ledger and a different day.
    expect(b.event.ledger).not.toBe(a.event.ledger);
    expect(b.event.ledgerClosedAt).not.toBe(a.event.ledgerClosedAt);
    const out = await runTaxEstimate(req, deps(chain([a, b])));
    // Defect: this is "ok", with the second payment valued at the 2026-11-26 rate.
    expect(out.status).toBe("unavailable");
  });
});
