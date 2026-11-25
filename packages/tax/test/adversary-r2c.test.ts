import { describe, expect, it } from "vitest";
import { cbn } from "./helpers";
import { estimate } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const acct: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };
const inc = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T05:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10000",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over });
const inp = (entries: LedgerEntry[], over: Record<string, unknown> = {}): EstimateInput =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts: [acct], profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over }) as EstimateInput;

describe("adv r2c tax", () => {
  it("baseline: 10000 USDC at 1500 is 15,000,000 gross", () => {
    const r = estimate(inp([inc()]));
    expect(r.status === "ok" && r.grossIncomeNgn).toBe("15000000.00");
  });
  it("taxYear given as the string '2026' (JSON from an API) must not return ok with the year's income silently dropped", () => {
    const r = estimate(inp([inc()], { taxYear: "2026" }));
    // it resolves the rules (template key) but periodEnd becomes NaN, so no entry is 'in year'
    expect(r.status === "ok" ? r.grossIncomeNgn : "refused").not.toBe("0.00");
  });
});
