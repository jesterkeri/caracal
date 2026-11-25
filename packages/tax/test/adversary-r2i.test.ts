import { describe, expect, it } from "vitest";
import { cbn } from "./helpers";
import { estimate } from "../src";

const acct = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] as { from: string; to: string }[] };
const inc = (over: Record<string, unknown> = {}) => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T05:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10000",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over });
const inp = (entries: unknown[], accounts: unknown[] = [acct]) =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts, profile: { incomeScope: { allIncomeInLinkedAccounts: true } } }) as never;

// All LOW confidence: README does not say these outright.
describe("adv r2i tax [LOW confidence]", () => {
  // README Entry: "`id`, `accountId`, ..., `txHash`, ..."; "The input is not the documented structure" refuses.
  it("entry with no txHash (income line would carry txHash undefined) must refuse", () => {
    const { txHash: _t, ...e } = inc();
    expect(estimate(inp([e])).status).toBe("refused");
  });
  // README: "A tax year ... A gap that overlaps the tax year" refuses. Gap ending exactly at year start is treated as overlapping, but a gap starting exactly at year end is not: inconsistent.
  it("a gap that merely touches the year at one instant is treated the same at both ends", () => {
    const touchStart = estimate(inp([], [{ ...acct, gaps: [{ from: "2025-06-01T00:00:00Z", to: "2025-12-31T23:00:00Z" }] }])).status;
    const touchEnd = estimate(inp([], [{ ...acct, gaps: [{ from: "2026-12-31T23:00:00Z", to: "2027-02-01T00:00:00Z" }] }])).status;
    expect(touchStart).toBe(touchEnd);
  });
  // The same on-chain payment listed under two entry ids is counted twice.
  it("two income entries with the same txHash and same amount are not both counted", () => {
    const r = estimate(inp([inc({ id: "1" }), inc({ id: "2" })]));
    expect(r.status === "refused" || (r.status === "ok" && r.grossIncomeNgn === "15000000.00")).toBe(true);
  });
});
