import { describe, expect, it } from "vitest";
import { cbn, mkt } from "./helpers";
import { estimate } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const ASOF = "2026-12-01T12:00:00Z";
const acct: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };
function inc(over: Partial<LedgerEntry> = {}, fxdate = "2026-05-10"): LedgerEntry {
  return { id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10",
    fx: { statutory: cbn("1500", fxdate), economic: null }, ...over };
}
function inp(entries: LedgerEntry[], over: Partial<EstimateInput> = {}, a: Account = acct): EstimateInput {
  return { country: "NG", taxYear: 2026, asOf: ASOF, entries, accounts: [a], profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over } as EstimateInput;
}
const refused = (i: EstimateInput) => estimate(i).status === "refused";

describe("adv r1 tax", () => {
  it("baseline ok", () => { expect(estimate(inp([inc()])).status).toBe("ok"); });
  for (const bad of ["2026-02-30T00:00:00Z", "2026-05-10T24:00:00Z", "2026-05-10T10:00:00+01:60", "2026-05-10T10:00:00+1:00",
    "2026-05-10T10:00:00z", "2026-13-10T10:00:00Z", "2026-05-10T25:00:00Z", "2026-05-10T10:61:00Z", "2026-05-10T10:00:00+99:99", "2026-05-10T10:00:61Z", "2026-05-10T10:00:00+24:00"]) {
    it(`occurredAt ${bad} refuses`, () => { expect(refused(inp([inc({ occurredAt: bad })]))).toBe(true); });
    it(`lastSyncedAt ${bad} refuses`, () => { expect(refused(inp([inc()], {}, { ...acct, lastSyncedAt: bad }))).toBe(true); });
    it(`coverageFrom ${bad} refuses`, () => { expect(refused(inp([inc()], {}, { ...acct, coverageFrom: bad }))).toBe(true); });
    it(`asOf ${bad} refuses`, () => { expect(refused(inp([inc()], { asOf: bad }))).toBe(true); });
  }
  it("UTC-date quote but Lagos next day refuses", () => {
    expect(refused(inp([inc({ occurredAt: "2026-05-10T23:30:00Z" }, "2026-05-10")]))).toBe(true);
    expect(refused(inp([inc({ occurredAt: "2026-05-10T23:30:00Z" }, "2026-05-11")]))).toBe(false);
  });
  it("offset instant uses Lagos date", () => {
    expect(refused(inp([inc({ occurredAt: "2026-05-10T20:00:00-05:00" }, "2026-05-10")]))).toBe(true);
    expect(refused(inp([inc({ occurredAt: "2026-05-10T20:00:00-05:00" }, "2026-05-11")]))).toBe(false);
  });
  it("year boundary Lagos", () => {
    expect(refused(inp([inc({ occurredAt: "2025-12-31T23:30:00Z" }, "2026-01-01")]))).toBe(false);
  });
  it("coverage boundaries", () => {
    expect(refused(inp([inc()], {}, { ...acct, coverageFrom: "2026-01-01T00:00:00+01:00" }))).toBe(false);
    expect(refused(inp([inc()], {}, { ...acct, coverageFrom: "2026-01-01T00:00:00Z" }))).toBe(true);
    expect(refused(inp([inc()], {}, { ...acct, openedAt: "2026-03-01T00:00:00Z", coverageFrom: "2026-03-01T00:00:00Z" }))).toBe(false);
    expect(refused(inp([inc()], {}, { ...acct, openedAt: "2026-03-01T00:00:00Z", coverageFrom: "2026-03-01T00:00:01Z" }))).toBe(true);
    expect(refused(inp([inc()], {}, { ...acct, openedAt: "2024-03-01T00:00:00Z", coverageFrom: "2026-01-01T00:00:00Z" }))).toBe(true);
    expect(refused(inp([inc()], {}, { ...acct, openedAt: "garbage" as string }))).toBe(true);
  });
  it("gaps", () => {
    expect(refused(inp([inc()], {}, { ...acct, gaps: [{ from: "2026-06-02T00:00:00Z", to: "2026-06-01T00:00:00Z" }] }))).toBe(true);
    expect(refused(inp([inc()], {}, { ...acct, gaps: [{ from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" }] }))).toBe(true);
    expect(refused(inp([inc()], {}, { ...acct, gaps: [{ from: "2025-06-01T00:00:00Z", to: "2025-06-02T00:00:00Z" }] }))).toBe(false);
  });
  it("entries / accounts", () => {
    expect(refused(inp([inc({ accountId: "zzz", occurredAt: "2020-01-01T00:00:00Z" })]))).toBe(true);
    expect(refused(inp([inc({ accountId: undefined as unknown as string })]))).toBe(true);
    expect(refused(inp([inc({ accountId: "__proto__" })]))).toBe(true);
    expect(refused(inp([inc({ accountId: "constructor" })]))).toBe(true);
    expect(refused(inp([inc({ kind: "other" })]))).toBe(true);
    expect(refused(inp([inc({ kind: "other", direction: "out" })]))).toBe(false);
    expect(refused(inp([inc({ kind: "other", occurredAt: "2025-05-10T10:00:00Z" })]))).toBe(false);
    expect(refused(inp([inc({ kind: "other", occurredAt: "2025-12-31T23:30:00Z" })]))).toBe(true); // Lagos 2026-01-01
    expect(refused(inp([inc({ kind: "other", occurredAt: "2026-12-31T23:30:00Z" })], { asOf: "2027-01-02T00:00:00Z" }, { ...acct, lastSyncedAt: "2027-01-01T00:00:00Z" }))).toBe(false);
  });
  it("quote validation", () => {
    for (const d of ["2026-5-10", "2026-05-10T00:00:00Z", "", "2026-02-30", " 2026-05-10"]) expect(refused(inp([inc({}, d)]))).toBe(true);
    const e = inc(); e.fx.statutory!.provider = "  "; expect(refused(inp([e]))).toBe(true);
    const f = inc(); f.fx.economic = mkt("abc", "2026-05-10"); expect(refused(inp([f]))).toBe(true);
    const g = inc(); g.fx.economic = mkt("1600", "2026-05-10", { provider: "" }); expect(refused(inp([g]))).toBe(true);
    const h = inc(); h.fx.economic = mkt("1600", "nope"); expect(refused(inp([h]))).toBe(true);
  });
  it("income scope", () => {
    const P = (p: unknown) => inp([inc()], { profile: p as never });
    expect(refused(P({}))).toBe(true);
    expect(refused(P({ incomeScope: { allIncomeInLinkedAccounts: "true" } }))).toBe(true);
    expect(refused(P({ incomeScope: { allIncomeInLinkedAccounts: false } }))).toBe(true);
    expect(refused(P({ incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "-5" } }))).toBe(true);
    expect(refused(P({ incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "1e3" } }))).toBe(true);
    expect(refused(P({ incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: 5 } }))).toBe(true);
    expect(refused(P({ incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "" } }))).toBe(true);
    const r = estimate(P({ incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: " 1000 " } }));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.grossIncomeNgn).toBe("16000.00");
    const big = estimate(P({ incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "9".repeat(40) } }));
    expect(big.status).toBe("ok");
  });
  it("TZ independence", () => {
    const r = JSON.stringify(estimate(inp([inc({ occurredAt: "2026-05-10T23:30:00Z" }, "2026-05-11")])));
    expect(r).toContain('"ok"');
  });
});
