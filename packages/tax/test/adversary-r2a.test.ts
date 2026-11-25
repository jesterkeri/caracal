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
const st = (i: EstimateInput) => estimate(i).status;

describe("adv r2a tax", () => {
  it("baseline ok", () => expect(st(inp([inc()]))).toBe("ok"));
  it("quote retrieved a year before its own date refuses", () =>
    expect(st(inp([inc({}, cbn("1500", "2026-05-10", { retrievedAt: "2025-01-01T00:00:00Z" }))]))).toBe("refused"));
  it("year-end income may be missing: synced before year end, asOf after", () =>
    expect(st(inp([], { asOf: "2027-01-01T05:00:00+01:00" }, { ...acct, lastSyncedAt: "2026-12-31T06:00:00+01:00" }))).toBe("refused"));
  it("entry dated after its account's lastSyncedAt cannot be known", () =>
    expect(st(inp([inc({ occurredAt: "2026-12-01T08:00:00Z", fx: { statutory: cbn("1500", "2026-12-01"), economic: null } })]))).toBe("refused"));
  it("entry before its account was opened cannot be true", () =>
    expect(st(inp([inc()], {}, { ...acct, openedAt: "2026-08-01T00:00:00Z", coverageFrom: "2026-08-01T00:00:00Z" }))).toBe("refused"));
  it("entry before coverageFrom (outside proven history) ", () =>
    expect(st(inp([inc()], {}, { ...acct, coverageFrom: "2026-08-01T00:00:00Z" }))).toBe("refused"));
  it("unknown kind on in-year incoming entry must not vanish", () =>
    expect(st(inp([inc({ kind: "Income" as never })]))).toBe("refused"));
  it("unknown direction must not vanish", () =>
    expect(st(inp([inc({ direction: "IN" as never })]))).toBe("refused"));
  it("estimate for a year that has not started (asOf 2025)", () =>
    expect(st(inp([], { asOf: "2025-06-01T00:00:00Z" }, { ...acct, lastSyncedAt: "2025-05-31T12:00:00Z" }))).toBe("refused"));
  it("rate with absurd precision is refused", () =>
    expect(st(inp([inc({}, cbn("1500.123456789012345", "2026-05-10"))]))).toBe("refused"));
});
