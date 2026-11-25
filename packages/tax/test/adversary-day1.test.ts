import { describe, expect, it } from "vitest";
import { estimate } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const ASOF = "2026-12-01T12:00:00Z";
const acct: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", gaps: [] };
function inc(id: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, txHash: `tx-${id}`, occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income",
    asset: "USDC", amount: "100",
    fx: { statutory: { ngnPerUnit: "1500", source: "CBN", date: "2026-05-10" }, economic: null }, ...over,
  };
}
const inp = (entries: LedgerEntry[], over: Partial<EstimateInput> = {}): EstimateInput =>
  ({ country: "NG", taxYear: 2026, asOf: ASOF, entries, accounts: [acct], profile: {}, ...over });

describe("adversary day 1: tax", () => {
  it("NaN staleAfterHours must not silently disable the freshness check", () => {
    const old: Account = { ...acct, lastSyncedAt: "2026-01-01T00:00:00Z" };
    const r = estimate(inp([inc("1")], { accounts: [old], staleAfterHours: NaN }));
    expect(r.status).toBe("refused");
  });
  it("same entry id twice must not be counted twice", () => {
    const r = estimate(inp([inc("1"), inc("1")]));
    expect(r.status).toBe("refused");
  });
  it("no accounts at all means freshness is unverifiable: refuse", () => {
    const r = estimate(inp([inc("1")], { accounts: [] }));
    expect(r.status).toBe("refused");
  });
  it("account synced in the future relative to asOf is not fresh evidence", () => {
    const fut: Account = { ...acct, lastSyncedAt: "2027-06-01T00:00:00Z" };
    const r = estimate(inp([inc("1")], { accounts: [fut] }));
    expect(r.status).toBe("refused");
  });
  it("income dated after asOf must not be valued as received", () => {
    const r = estimate(inp([inc("1", { occurredAt: "2026-12-20T10:00:00Z" })]));
    expect(r.status).toBe("refused");
  });
  it("offset-less timestamp must not be interpreted in machine-local time", () => {
    const a = estimate(inp([inc("1", { occurredAt: "2025-12-31T23:30:00" })]));
    // 23:30 on Dec 31 is outside 2026 in any zone at or west of Lagos, so gross must be 0
    if (a.status === "ok") expect(a.grossIncomeNgn).toBe("0.00");
  });
});
