import { describe, expect, it } from "vitest";
import { cbn } from "./helpers";
import { estimate } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const acct: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };
const inc = (over: Partial<LedgerEntry> = {}, fx = cbn("1500", "2026-05-10")): LedgerEntry => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10",
  fx: { statutory: fx, economic: null }, ...over });
const inp = (entries: LedgerEntry[], over: Partial<EstimateInput> = {}, a: Account = acct): EstimateInput =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts: [a], profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over }) as EstimateInput;

describe("adv r2b tax", () => {
  it("baseline ok", () => expect(estimate(inp([inc()])).status).toBe("ok"));

  it("an entry dated after its account's lastSyncedAt (but before asOf, valid quote) is not provable and must refuse", () => {
    // synced 06:00Z, entry at 09:00Z the same day, asOf 12:00Z, quote fetched 10:00Z.
    const e = inc({ occurredAt: "2026-12-01T09:00:00Z", fx: { statutory: cbn("1500", "2026-12-01", { retrievedAt: "2026-12-01T10:00:00Z" }), economic: null } });
    expect(estimate(inp([e])).status).toBe("refused");
  });

  it("scope says all income is in linked accounts but also carries otherIncomeNgn: contradictory, must refuse", () => {
    const r = estimate(inp([inc()], { profile: { incomeScope: { allIncomeInLinkedAccounts: true, otherIncomeNgn: "9000000" } as never } }));
    expect(r.status).toBe("refused");
  });

  it("declared other income with sub-kobo precision is refused, not silently rounded", () => {
    const r = estimate(inp([inc()], { profile: { incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "1000.005" } } }));
    expect(r.status).toBe("refused");
  });

  it("rent with sub-kobo precision is refused, not silently rounded", () => {
    const r = estimate(inp([inc()], { profile: { annualRentNgn: "1000000.004", incomeScope: { allIncomeInLinkedAccounts: true } } }));
    expect(r.status).toBe("refused");
  });
});
