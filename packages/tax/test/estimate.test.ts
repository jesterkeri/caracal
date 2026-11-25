import { describe, expect, it } from "vitest";
import { estimate, getRules, stampDutyOnCashout } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const ASOF = "2026-12-01T12:00:00Z";
const okAccount: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", gaps: [] };

function income(id: string, amount: string, rate: string | null, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    txHash: `tx-${id}`,
    occurredAt: "2026-05-10T10:00:00Z",
    direction: "in",
    kind: "income",
    asset: "USDC",
    amount,
    fx: {
      statutory: rate === null ? null : { ngnPerUnit: rate, source: "CBN", date: "2026-05-10" },
      economic: null,
    },
    ...over,
  };
}

function input(entries: LedgerEntry[], over: Partial<EstimateInput> = {}): EstimateInput {
  return { country: "NG", taxYear: 2026, asOf: ASOF, entries, accounts: [okAccount], profile: {}, ...over };
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
    const r = ok(input([income("1", "3000000", "1")], { profile: { annualRentNgn: "1000000" } }));
    expect(r.reliefs[0]!.amountNgn).toBe("200000.00");
    expect(r.taxableIncomeNgn).toBe("2800000.00");
  });
  it("is capped at N500,000", () => {
    const r = ok(input([income("1", "3000000", "1")], { profile: { annualRentNgn: "9000000" } }));
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
    const r = ok(input([income("1", "100", "1", { occurredAt: "2025-12-31T23:30:00Z" })]));
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
    e.fx.economic = { ngnPerUnit: "1600", source: "market", date: "2026-05-10" };
    const l = ok(input([e])).incomeLines[0]!;
    expect(l.economicNgnValue).toBe("800000.00");
    expect(l.fxGapPct).toBe("4.41");
  });
  it("is negative when the market is below the official rate", () => {
    const e = income("1", "100", "1500");
    e.fx.economic = { ngnPerUnit: "1425", source: "market", date: "2026-05-10" };
    expect(ok(input([e])).incomeLines[0]!.fxGapPct).toBe("-5.00");
  });
  it("is omitted without an economic quote", () => {
    expect(ok(input([income("1", "1", "1")])).incomeLines[0]).not.toHaveProperty("fxGapPct");
  });
});

describe("stamp duty", () => {
  const rules = getRules("NG", 2026)!;
  it("is 1.5% of the amount", () => {
    expect(stampDutyOnCashout("766225", rules)).toMatchObject({
      duty: "11493.38",
      rate: "0.015",
      ruleId: "NG-2026-STAMP-CONVERSION",
      source: { confidence: "secondary" },
    });
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
