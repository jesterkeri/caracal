import { describe, expect, it } from "vitest";
import { cbn, mkt } from "./helpers";
import { estimate } from "../src";
import type { Account, EstimateInput, FxQuote, LedgerEntry } from "../src";

const ASOF = "2026-12-01T12:00:00Z";
const acct: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };
const inc = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over,
});
const withFx = (statutory: FxQuote | null, economic: FxQuote | null = null) => inc({ fx: { statutory, economic } });
const inp = (entries: LedgerEntry[], over: Partial<EstimateInput> = {}, a: Account = acct): EstimateInput =>
  ({ country: "NG", taxYear: 2026, asOf: ASOF, entries, accounts: [a], profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over });
const reasons = (i: EstimateInput): string => {
  const r = estimate(i);
  return r.status === "refused" ? r.reasons.join(" | ") : "ok";
};

describe("F3 account chronology", () => {
  it("baseline is ok", () => expect(reasons(inp([inc()]))).toBe("ok"));
  it("the reported repro refuses", () => {
    const a = { ...acct, openedAt: "2027-02-01T00:00:00Z", coverageFrom: "2027-02-01T00:00:00Z" };
    expect(reasons(inp([], {}, a))).toContain('Account "Main": openedAt');
  });
  it("openedAt after asOf", () => {
    const a = { ...acct, openedAt: "2026-12-02T00:00:00Z", coverageFrom: "2026-12-02T00:00:00Z", lastSyncedAt: "2026-12-02T00:00:00Z" };
    expect(reasons(inp([], { asOf: "2026-12-03T00:00:00Z" }, { ...a, openedAt: "2026-12-04T00:00:00Z" }))).toContain('Account "Main": openedAt');
  });
  it("coverageFrom after asOf", () => {
    expect(reasons(inp([], {}, { ...acct, coverageFrom: "2026-12-02T00:00:00Z" }))).toContain('Account "Main": coverageFrom');
  });
  it("lastSyncedAt before openedAt", () => {
    const a = { ...acct, openedAt: "2026-06-01T00:00:00Z", coverageFrom: "2026-06-01T00:00:00Z", lastSyncedAt: "2026-05-01T00:00:00Z" };
    expect(reasons(inp([], { staleAfterHours: 100000 }, a))).toContain('Account "Main": lastSyncedAt');
    expect(reasons(inp([], { staleAfterHours: 100000 }, a))).toContain("before openedAt");
  });
  it("lastSyncedAt before coverageFrom", () => {
    const a = { ...acct, coverageFrom: "2026-01-01T00:00:00+01:00", lastSyncedAt: "2025-06-01T00:00:00Z" };
    expect(reasons(inp([], { staleAfterHours: 100000 }, a))).toContain("before coverageFrom");
  });
});

describe("F4 structured statutory quote", () => {
  const stat = (over: Partial<FxQuote>) => reasons(inp([withFx(cbn("1500", "2026-05-10", over))]));
  it("valid quote is ok and the line carries provider, pair, date, url", () => {
    const r = estimate(inp([inc()]));
    expect(r.status === "ok" && r.incomeLines[0]).toMatchObject({
      rateProvider: "Central Bank of Nigeria", ratePair: "USD/NGN", rateDate: "2026-05-10", rateSourceUrl: "https://www.cbn.gov.ng/rates/ExchRateByCurrency.html",
    });
    expect(r.status === "ok" && r.incomeLines[0]).not.toHaveProperty("rateSource");
  });
  it("free-form label from the review repro refuses", () => {
    const old = { ngnPerUnit: "1", source: "made up", date: "2026-05-10" } as unknown as FxQuote;
    expect(reasons(inp([withFx(old)]))).not.toBe("ok");
  });
  it("unknown provider", () => expect(stat({ provider: "made up" })).toContain("not an accepted official source"));
  it("sourceUrl outside the provider prefix", () => expect(stat({ sourceUrl: "https://evil.example.com/cbn" })).toContain("sourceUrl must start with"));
  it("quote currency other than NGN", () => expect(stat({ quote: "USD" as never })).toContain("quoted in NGN"));
  it("base that does not match the asset", () => expect(stat({ base: "EUR" })).toContain("EUR/NGN"));
  it("retrievedAt after asOf", () => expect(stat({ retrievedAt: "2026-12-02T00:00:00Z" })).toContain("retrievedAt"));
  it("retrievedAt invalid", () => expect(stat({ retrievedAt: "yesterday" })).toContain("retrievedAt"));
  it("date on a different day fails same_day", () => expect(stat({ date: "2026-05-09" })).toContain("same day"));
  it("XLM refuses and says only USDC can be valued", () => {
    const r = reasons(inp([inc({ asset: "XLM" })]));
    expect(r).toContain("Only USDC can be valued today");
  });
  it("__proto__ is not an asset", () => expect(reasons(inp([inc({ asset: "__proto__" })]))).toContain("cannot be valued yet"));
});

describe("F5 strict instants", () => {
  const BAD = "2026-02-30T12:00:00Z";
  const cases: [string, EstimateInput][] = [
    ["asOf", inp([inc()], { asOf: BAD })],
    ["occurredAt", inp([inc({ occurredAt: BAD })])],
    ["lastSyncedAt", inp([inc()], {}, { ...acct, lastSyncedAt: BAD })],
    ["coverageFrom", inp([inc()], {}, { ...acct, coverageFrom: BAD })],
    ["openedAt", inp([inc()], {}, { ...acct, openedAt: BAD })],
    ["gap from", inp([inc()], {}, { ...acct, gaps: [{ from: BAD, to: "2025-01-02T00:00:00Z" }] })],
    ["gap to", inp([inc()], {}, { ...acct, gaps: [{ from: "2025-01-01T00:00:00Z", to: BAD }] })],
    ["retrievedAt", inp([withFx(cbn("1500", "2026-05-10", { retrievedAt: BAD }))])],
    ["retrievedAt", inp([withFx(cbn("1500", "2026-05-10"), mkt("1600", "2026-05-10", { retrievedAt: BAD }))])],
  ];
  for (const [field, i] of cases) {
    it(`impossible ${field} refuses and names it`, () => expect(reasons(i)).toContain(field));
  }
  it("accepts a leap day and rejects a non-leap one", () => {
    // The year is closed at this asOf, so the account must be synced up to it.
    const at = (d: string) => estimate(inp([], { asOf: d, staleAfterHours: 1e7 }, { ...acct, lastSyncedAt: d })).status;
    expect(at("2028-02-29T12:00:00Z")).toBe("ok");
    for (const d of ["2026-02-29T12:00:00Z", "1900-02-29T12:00:00Z"]) {
      expect(reasons(inp([], { asOf: d }))).toContain("asOf is not a valid date");
    }
  });
  it("offset limits", () => {
    const at = (d: string) => estimate(inp([], { asOf: d, staleAfterHours: 1e7 })).status;
    expect(at("2026-12-02T12:00:00+14:00")).toBe("ok");
    expect(at("2026-12-02T12:00:00+14:01")).toBe("refused");
    expect(at("2026-12-02T12:00:00-15:00")).toBe("refused");
    expect(at("2026-12-02T12:00:00+05:60")).toBe("refused");
  });
  it("fraction optional and parsed", () => {
    expect(estimate(inp([], { asOf: "2026-12-01T12:00:00.123Z" })).status).toBe("ok");
  });
  it("impossible quote date refuses", () => {
    expect(reasons(inp([withFx(cbn("1500", "2026-04-31"))]))).toContain("date");
  });
});

describe("F6 economic quote", () => {
  const e = (econ: FxQuote) => inp([withFx(cbn("1500", "2026-05-10"), econ)]);
  it("same-day quote is used and carries provider, date, url", () => {
    const r = estimate(e(mkt("1600", "2026-05-10")));
    expect(r.status === "ok" && r.incomeLines[0]).toMatchObject({
      economicNgnValue: "16000.00", fxGapPct: "6.67",
      economicQuote: { provider: "market-feed", pair: "USD/NGN", date: "2026-05-10", sourceUrl: "https://rates.example.com/usd-ngn" },
    });
  });
  it("a 2010 quote does not refuse, omits the gap and adds a note", () => {
    const r = estimate(e(mkt("1600", "2010-05-10")));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.incomeLines[0]).not.toHaveProperty("economicNgnValue");
    expect(r.incomeLines[0]).not.toHaveProperty("fxGapPct");
    expect(r.grossIncomeNgn).toBe("15000.00");
    const n = r.informational.find((x) => x.kind === "fx_gap_omitted");
    expect(n?.message).toContain("Entry 1");
    expect(n?.message).toContain("2010-05-10");
  });
  it("malformed economic quotes still refuse", () => {
    expect(reasons(e(mkt("1600", "2026-05-10", { sourceUrl: "http://insecure.example.com" })))).toContain("https");
    expect(reasons(e(mkt("1600", "2026-05-10", { provider: " " })))).toContain("provider");
    expect(reasons(e(mkt("1600", "2026-05-10", { quote: "USD" as never })))).toContain("NGN");
    expect(reasons(e(mkt("1600", "2026-05-10", { retrievedAt: "2027-01-01T00:00:00Z" })))).toContain("retrievedAt");
    expect(reasons(e(mkt("0", "2026-05-10")))).toContain("zero");
    expect(reasons(e(mkt("1600", "2026-02-30")))).toContain("date");
  });
});
