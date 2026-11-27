// Two payments in one transaction with the same account, asset and amount are
// told apart by the reference each carries on chain (adversary t4: two invoices
// of the same amount paid in one batch transaction).
import { describe, expect, it } from "vitest";
import { cbn } from "./helpers";
import { estimate } from "../src";

const acct = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] as { from: string; to: string }[] };
const inc = (over: Record<string, unknown> = {}) => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T05:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10000",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over });
const inp = (entries: unknown[]) =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts: [acct], profile: { incomeScope: { allIncomeInLinkedAccounts: true } } }) as never;

describe("paymentRef in the duplicate check", () => {
  it("different references in one transaction are two payments, both counted", () => {
    const r = estimate(inp([inc({ id: "1", paymentRef: "inv-a" }), inc({ id: "2", paymentRef: "inv-b" })]));
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.grossIncomeNgn).toBe("30000000.00");
  });
  it("the same reference twice is still the same payment listed twice", () => {
    const r = estimate(inp([inc({ id: "1", paymentRef: "inv-a" }), inc({ id: "2", paymentRef: "inv-a" })]));
    expect(r.status).toBe("refused");
  });
  it("no reference on either is still refused", () => {
    expect(estimate(inp([inc({ id: "1" }), inc({ id: "2" })])).status).toBe("refused");
  });
  it("a reference that is not a string does not tell two entries apart", () => {
    expect(estimate(inp([inc({ id: "1", paymentRef: 1 }), inc({ id: "2", paymentRef: 2 })])).status).toBe("refused");
  });
});
