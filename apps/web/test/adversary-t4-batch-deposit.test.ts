// Adversary t4: two different invoices paid in one transaction for the same
// amount are refused as "the same payment listed twice", although the chain
// record proves they are two payments.
//
// Promise: the page "refuses when it cannot prove it has all your payments"
// and must not refuse when every fact is proven (goal 1 of this pass).
// The contract's `split` event carries `invoice_ref`, and the contract allows
// only one deposit per invoice (docs/decisions.md 2026-11-25 "one deposit per
// invoice"; contracts/split/README.md `deposit`). So two split events with
// different invoice refs and different event ids are two payments, even when
// they share a transaction hash, payer and amount (a client's batch contract
// paying three identical monthly retainers in one transaction does exactly
// that: deposit(from, amount, ref) is called once per invoice).
//
// The pipeline builds engine entries with only the event id, tx hash and
// amount (apps/web/src/lib/tax/pipeline.ts), so the engine's duplicate guard
// (packages/tax/src/estimate.ts, `paymentKeys`) cannot tell a batch from a
// listing twice, and the whole estimate refuses. The invoice ref, which the
// pipeline has, is what tells them apart.
//
// Events are CONSTRUCTED in the real RPC wire format by the t1 harness; the
// CBN rates are the real captured rows.
import { describe, expect, it } from "vitest";
import { runTaxEstimate } from "./tax-classify-harness";
import { WALLET, chain, deps, payment, type Item } from "./adversary-t1-harness";

/** `second` rewritten to sit in the same transaction (same hash, ledger and close time) as `first`, as a batch call would. */
function sameTransaction(first: Item, second: Item): Item {
  return {
    event: { ...second.event, ledger: first.event.ledger, txHash: first.event.txHash, id: first.event.id.replace(/-\d+$/, "-0000000002") },
    tx: first.tx,
  };
}

describe("adversary t4: a batch payment of two invoices of the same amount", () => {
  const closedAt = "2026-11-25T10:00:00Z";
  const req = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" as const } };

  it("control: two invoices of DIFFERENT amounts in one transaction are both counted", async () => {
    const a = payment(closedAt, 10_000_000_000); // 1,000 USDC
    const b = sameTransaction(a, payment(closedAt, 5_000_000_000)); // 500 USDC
    const out = await runTaxEstimate(req, deps(chain([a, b])));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.incomeLines).toHaveLength(2);
  });

  it("control: one invoice listed twice (same invoice ref) is still refused, never counted twice", async () => {
    const a = payment(closedAt, 10_000_000_000);
    const dup = { event: { ...a.event, id: a.event.id.replace(/-\d+$/, "-0000000002") }, tx: a.tx };
    const out = await runTaxEstimate(req, deps(chain([a, dup])));
    expect(out.status).toBe("refused");
  });

  it("counts two invoices of the same amount paid in one transaction, as two payments (it refuses today)", async () => {
    const a = payment(closedAt, 10_000_000_000);
    const b = sameTransaction(a, payment(closedAt, 10_000_000_000));
    // Two different invoices, so two different payments.
    expect(a.event.value).not.toBe(b.event.value);
    const out = await runTaxEstimate(req, deps(chain([a, b])));
    // The refusal is the engine's duplicate guard, not anything about the chain read.
    expect(out.status === "refused" ? out.reasons.join(" ") : "").not.toMatch(/same payment listed twice/);
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.incomeLines).toHaveLength(2);
  });
});
