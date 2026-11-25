import { describe, expect, it } from "vitest";
import { cbn, mkt } from "./helpers";
import { estimate, getRules, stampDutyNotice } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const ALL = { allIncomeInLinkedAccounts: true } as const;
const ASOF = "2026-12-01T12:00:00Z";
const okAccount: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };

function income(id: string, amount: string, rate: string | null, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    accountId: "a1",
    txHash: `tx-${id}`,
    occurredAt: "2026-05-10T10:00:00Z",
    direction: "in",
    kind: "income",
    asset: "USDC",
    amount,
    fx: {
      statutory: rate === null ? null : cbn(rate, "2026-05-10"),
      economic: null,
    },
    ...over,
  };
}

function input(entries: LedgerEntry[], over: Partial<EstimateInput> = {}): EstimateInput {
  return { country: "NG", taxYear: 2026, asOf: ASOF, entries, accounts: [okAccount], profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over };
}

function ok(i: EstimateInput) {
  const r = estimate(i);
  if (r.status !== "ok") throw new Error("refused: " + r.reasons.join("; "));
  return r;
}

describe("band boundaries", () => {
  it("N800,000 exactly pays no tax", () => {
    const r = ok(input([income("1", "800000", "1")]));
    expect(r.grossIncomeNgn).toBe("800000.00");
    expect(r.totalTaxNgn).toBe("0.00");
    expect(r.bands[1]!.taxableInBand).toBe("0.00");
  });
  it("N3,000,000 pays 330,000", () => {
    const r = ok(input([income("1", "3000000", "1")]));
    expect(r.totalTaxNgn).toBe("330000.00");
    expect(r.bands[2]!.taxableInBand).toBe("0.00");
  });
  it("N50,000,001 pays 10,430,000.25", () => {
    const r = ok(input([income("1", "50000001", "1")]));
    expect(r.totalTaxNgn).toBe("10430000.25");
    expect(r.bands[5]!.taxableInBand).toBe("1.00");
    expect(r.bands[5]!.ruleId).toBe("NG-2026-PIT-BAND-6");
  });
});

describe("rent relief", () => {
  it("is 20% of rent below the cap", () => {
    const r = ok(input([income("1", "3000000", "1")], { profile: { annualRentNgn: "1000000", incomeScope: ALL } }));
    expect(r.reliefs[0]!.amountNgn).toBe("200000.00");
    expect(r.taxableIncomeNgn).toBe("2800000.00");
  });
  it("is capped at N500,000", () => {
    const r = ok(input([income("1", "3000000", "1")], { profile: { annualRentNgn: "9000000", incomeScope: ALL } }));
    expect(r.reliefs[0]!.amountNgn).toBe("500000.00");
    expect(r.taxableIncomeNgn).toBe("2500000.00");
  });
  it("is absent when no rent is given", () => {
    expect(ok(input([income("1", "1000", "1")])).reliefs).toEqual([]);
  });
});

describe("refusals", () => {
  it("missing statutory rate", () => {
    const r = estimate(input([income("1", "10", null)]));
    expect(r).toMatchObject({ status: "refused" });
    expect(JSON.stringify(r)).not.toContain("grossIncomeNgn");
  });
  it("stale account", () => {
    const r = estimate(input([income("1", "10", "1")], {
      accounts: [{ ...okAccount, lastSyncedAt: "2026-11-30T11:59:00Z" }],
    }));
    expect(r.status).toBe("refused");
  });
  it("staleAfterHours override", () => {
    const i = input([income("1", "10", "1")], {
      accounts: [{ ...okAccount, lastSyncedAt: "2026-11-30T11:59:00Z" }],
      staleAfterHours: 48,
    });
    expect(estimate(i).status).toBe("ok");
  });
  it("gap overlapping the year", () => {
    const r = estimate(input([income("1", "10", "1")], {
      accounts: [{ ...okAccount, gaps: [{ from: "2026-03-01T00:00:00Z", to: "2026-03-05T00:00:00Z" }] }],
    }));
    expect(r.status).toBe("refused");
  });
  it("gap outside the year is fine", () => {
    const r = estimate(input([income("1", "10", "1")], {
      accounts: [{ ...okAccount, gaps: [{ from: "2024-03-01T00:00:00Z", to: "2024-03-05T00:00:00Z" }] }],
    }));
    expect(r.status).toBe("ok");
  });
  it("unknown year", () => {
    const r = estimate(input([], { taxYear: 2031 }));
    expect(r).toMatchObject({ status: "refused" });
    expect(r.status === "refused" && r.reasons[0]).toContain("2031");
  });
});

describe("what counts as income", () => {
  it("excludes own_transfer and split_internal", () => {
    const r = ok(input([
      income("1", "100", "1500"),
      income("2", "999", "1500", { kind: "own_transfer" }),
      income("3", "999", "1500", { kind: "split_internal" }),
    ]));
    expect(r.incomeLines.map((l) => l.entryId)).toEqual(["1"]);
    expect(r.grossIncomeNgn).toBe("150000.00");
  });
  it("excludes out-of-year entries and entries without a rate", () => {
    const r = ok(input([
      income("1", "100", "1"),
      income("2", "100", null, { occurredAt: "2025-12-31T10:00:00Z" }),
      income("3", "100", null, { occurredAt: "2027-01-01T10:00:00Z" }),
    ]));
    expect(r.incomeLines).toHaveLength(1);
  });
  it("uses the Lagos calendar year at the edges", () => {
    // 2025-12-31 23:30 UTC is already 2026-01-01 in Lagos.
    const r = ok(input([income("1", "100", "1", { occurredAt: "2025-12-31T23:30:00Z", fx: { statutory: cbn("1", "2026-01-01"), economic: null } })]));
    expect(r.incomeLines).toHaveLength(1);
  });
  it("ignores outgoing income-kind entries", () => {
    expect(ok(input([income("1", "100", "1", { direction: "out" })])).incomeLines).toEqual([]);
  });
});

describe("exact money", () => {
  it("0.0000001 USDC at 1532.45 rounds to 0.00 without float error", () => {
    const r = ok(input([income("1", "0.0000001", "1532.45")]));
    expect(r.incomeLines[0]!.ngnValue).toBe("0.00");
  });
  it("500 USDC at 1532.45 is exactly 766225.00", () => {
    const r = ok(input([income("1", "500", "1532.45")]));
    expect(r.incomeLines[0]!.ngnValue).toBe("766225.00");
    expect(r.grossIncomeNgn).toBe("766225.00");
    expect(r.totalTaxNgn).toBe("0.00");
  });
  it("rounds half up to the kobo", () => {
    // 0.00001 * 500 = 0.005 naira, which rounds half up to 0.01
    expect(ok(input([income("1", "0.00001", "500")])).incomeLines[0]!.ngnValue).toBe("0.01");
  });
});

describe("fx gap", () => {
  it("reports economic value and gap percent", () => {
    const e = income("1", "500", "1532.45");
    e.fx.economic = mkt("1600", "2026-05-10");
    const l = ok(input([e])).incomeLines[0]!;
    expect(l.economicNgnValue).toBe("800000.00");
    expect(l.fxGapPct).toBe("4.41");
  });
  it("is negative when the market is below the official rate", () => {
    const e = income("1", "100", "1500");
    e.fx.economic = mkt("1425", "2026-05-10");
    expect(ok(input([e])).incomeLines[0]!.fxGapPct).toBe("-5.00");
  });
  it("is omitted without an economic quote", () => {
    expect(ok(input([income("1", "1", "1")])).incomeLines[0]).not.toHaveProperty("fxGapPct");
  });
});

describe("stamp duty", () => {
  const rules = getRules("NG", 2026)!;
  it("is a notice only, with no amount deducted", () => {
    const n = stampDutyNotice(rules);
    expect(n).toMatchObject({
      status: "requires_review",
      ratePct: "1.50",
      borneBy: "transferee",
      ruleId: "NG-2026-STAMP-CONVERSION",
      source: { confidence: "secondary" },
    });
    expect(n).not.toHaveProperty("duty");
    expect(n.message).toContain("nothing is taken from your payout");
  });
});

describe("output labelling", () => {
  it("carries the disclaimer, sources and notModelled", () => {
    const r = ok(input([income("1", "10", "1")]));
    expect(r.disclaimer).toBe("This is an estimate, not tax advice.");
    expect(r.sources.every((s) => s.confidence && s.url && s.ruleId)).toBe(true);
    expect(r.informational.some((i) => i.kind === "not_modelled")).toBe(true);
    expect(estimate(input([], { taxYear: 2031 })).disclaimer).toBe("This is an estimate, not tax advice.");
  });
  it("has no em dashes in the rules data", () => {
    expect(JSON.stringify(getRules("NG", 2026))).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("fx quote validation", () => {
  const q = (over: object = {}) => cbn("1500", "2026-05-10", over);
  const withQ = (quote: object, entryOver: Partial<LedgerEntry> = {}) =>
    income("1", "100", "1500", { fx: { statutory: quote as never, economic: null }, ...entryOver });
  const reasonsOf = (i: EstimateInput) => {
    const r = estimate(i);
    return r.status === "refused" ? r.reasons.join("; ") : "ok";
  };
  it("May receipt with a January quote refuses", () => {
    expect(reasonsOf(input([withQ(q({ date: "2026-01-10" }))]))).toContain("same day");
  });
  it("empty or whitespace provider refuses", () => {
    expect(reasonsOf(input([withQ(q({ provider: "" }))]))).toContain("no provider");
    expect(reasonsOf(input([withQ(q({ provider: "   " }))]))).toContain("no provider");
  });
  it("invalid quote date refuses", () => {
    expect(estimate(input([withQ(q({ date: "10/05/2026" }))])).status).toBe("refused");
    expect(estimate(input([withQ(q({ date: "2026-02-30" }))])).status).toBe("refused");
  });
  it("compares the quote date with the Lagos calendar date", () => {
    // 23:30 UTC on 10 May is 00:30 on 11 May in Lagos.
    const e = (date: string) => withQ(q({ date, retrievedAt: `${date}T18:00:00Z` }), { occurredAt: "2026-05-10T23:30:00Z" });
    expect(estimate(input([e("2026-05-11")])).status).toBe("ok");
    expect(estimate(input([e("2026-05-10")])).status).toBe("refused");
  });
  it("unsupported rateDateRule refuses", () => {
    const rules = { ...getRules("NG", 2026)!, valuation: { ...getRules("NG", 2026)!.valuation, rateDateRule: "lookback_3d" } };
    const r = estimate(input([income("1", "10", "1")]), rules);
    expect(r.status).toBe("refused");
    expect(r.status === "refused" && r.reasons[0]).toContain("Unsupported rate date rule");
  });
  it("malformed or unsourced economic quote refuses", () => {
    const mk = (econ: object) => {
      const e = income("1", "100", "1500");
      e.fx.economic = econ as never;
      return estimate(input([e])).status;
    };
    expect(mk(mkt("abc", "2026-05-10"))).toBe("refused");
    expect(mk(mkt("1600", "2026-05-10", { provider: "" }))).toBe("refused");
    expect(mk(mkt("1600", "bad"))).toBe("refused");
  });
});

describe("coverage", () => {
  it("coverageFrom after the year start, no openedAt, refuses", () => {
    const a = { ...okAccount, coverageFrom: "2026-02-01T00:00:00Z" };
    expect(estimate(input([income("1", "10", "1")], { accounts: [a] })).status).toBe("refused");
  });
  it("account opened mid-year with coverageFrom == openedAt passes", () => {
    const a = { ...okAccount, openedAt: "2026-06-01T00:00:00Z", coverageFrom: "2026-06-01T00:00:00Z" };
    expect(estimate(input([income("1", "10", "1", { occurredAt: "2026-07-10T10:00:00Z", fx: { statutory: cbn("1", "2026-07-10"), economic: null } })], { accounts: [a] })).status).toBe("ok");
  });
  it("coverageFrom after openedAt refuses", () => {
    const a = { ...okAccount, openedAt: "2026-06-01T00:00:00Z", coverageFrom: "2026-06-05T00:00:00Z" };
    expect(estimate(input([], { accounts: [a] })).status).toBe("refused");
  });
  it("invalid coverageFrom or openedAt refuses", () => {
    expect(estimate(input([], { accounts: [{ ...okAccount, coverageFrom: "soon" }] })).status).toBe("refused");
    expect(estimate(input([], { accounts: [{ ...okAccount, openedAt: "soon" }] })).status).toBe("refused");
  });
  it("empty ledger with full coverage is ok with zero tax", () => {
    const r = ok(input([]));
    expect(r.grossIncomeNgn).toBe("0.00");
    expect(r.totalTaxNgn).toBe("0.00");
  });
  it("gap with from after to refuses, even outside the year", () => {
    const a = { ...okAccount, gaps: [{ from: "2024-03-05T00:00:00Z", to: "2024-03-01T00:00:00Z" }] };
    expect(estimate(input([], { accounts: [a] })).status).toBe("refused");
  });
  it("entry with an unknown accountId refuses", () => {
    expect(estimate(input([income("1", "10", "1", { accountId: "ghost" })])).status).toBe("refused");
  });
});

describe("unknown income and income scope", () => {
  it("in-year incoming other refuses and names the entry", () => {
    const r = estimate(input([income("77", "10", "1", { kind: "other" })]));
    expect(r.status === "refused" && r.reasons.join(" ")).toContain("Entry 77 is not classified yet");
  });
  it("outgoing other and out-of-year incoming other do not refuse", () => {
    expect(estimate(input([
      income("1", "10", "1", { kind: "other", direction: "out" }),
      income("2", "10", "1", { kind: "other", occurredAt: "2024-05-10T10:00:00Z" }),
    ])).status).toBe("ok");
  });
  it("missing incomeScope refuses", () => {
    const i = input([income("1", "10", "1")], { profile: {} as never });
    expect(estimate(i).status).toBe("refused");
  });
  it("false without a valid otherIncomeNgn refuses", () => {
    for (const p of [{ allIncomeInLinkedAccounts: false }, { allIncomeInLinkedAccounts: false, otherIncomeNgn: "lots" }]) {
      expect(estimate(input([], { profile: { incomeScope: p as never } })).status).toBe("refused");
    }
  });
  it("declared income is added to gross as a labelled line", () => {
    const r = ok(input([income("1", "100", "1500")], {
      profile: { incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "250000.50", otherIncomeNote: "Bank transfers" } },
    }));
    expect(r.declaredIncomeLines).toEqual([{ label: "Bank transfers", amountNgn: "250000.50", source: "declared by you" }]);
    expect(r.grossIncomeNgn).toBe("400000.50");
    expect(r.informational.some((n) => n.kind === "declared_income" && n.message.includes("not verified on chain"))).toBe(true);
  });
  it("declaredIncomeLines is empty when all income is linked", () => {
    expect(ok(input([])).declaredIncomeLines).toEqual([]);
  });
});

describe("offset-free timestamps", () => {
  const fields = (r: ReturnType<typeof estimate>) => (r.status === "refused" ? r.reasons.join("; ") : "ok");
  it("offset-free occurredAt refuses and names the field", () => {
    const r = estimate(input([income("1", "100", "1", { occurredAt: "2025-12-31T23:30:00" })]));
    expect(fields(r)).toContain("occurredAt");
  });
  it("offset-free asOf, lastSyncedAt, coverageFrom, openedAt and gap bounds refuse", () => {
    expect(fields(estimate(input([], { asOf: "2026-12-01T12:00:00" })))).toContain("asOf");
    const a = (over: object) => estimate(input([], { accounts: [{ ...okAccount, ...over }] }));
    expect(fields(a({ lastSyncedAt: "2026-12-01T06:00:00" }))).toContain("lastSyncedAt");
    expect(fields(a({ coverageFrom: "2025-01-01T00:00:00" }))).toContain("coverageFrom");
    expect(fields(a({ openedAt: "2025-01-01T00:00:00" }))).toContain("openedAt");
    expect(fields(a({ gaps: [{ from: "2024-01-01T00:00:00", to: "2024-01-02T00:00:00Z" }] }))).toContain("gap");
  });
  it("accepts numeric offsets", () => {
    expect(estimate(input([], { asOf: "2026-12-01T12:00:00+01:00" })).status).toBe("ok");
  });
  it("the Dec 31 / Jan 1 boundary does not depend on TZ", () => {
    const at = (occurredAt: string, date: string) =>
      estimate(input([income("1", "100", "1", { occurredAt, fx: { statutory: cbn("1", date), economic: null } })]));
    // Same instants written two ways must agree.
    const before = at("2025-12-31T23:30:00+01:00", "2025-12-31");
    const beforeUtc = at("2025-12-31T22:30:00Z", "2025-12-31");
    const after = at("2026-01-01T00:00:00+01:00", "2026-01-01");
    const afterUtc = at("2025-12-31T23:00:00Z", "2026-01-01");
    expect(before).toEqual(beforeUtc);
    expect(after).toEqual(afterUtc);
    expect(ok(input([])).grossIncomeNgn).toBe("0.00");
    expect(before.status === "ok" && before.incomeLines).toHaveLength(0);
    expect(after.status === "ok" && after.incomeLines).toHaveLength(1);
  });
});
