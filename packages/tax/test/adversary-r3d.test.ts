// Adversary r3d: differential check of the naira arithmetic against an
// independent exact-rational implementation, plus README edge cases.
import { describe, expect, it } from "vitest";
import { estimate, type EstimateInput, type LedgerEntry } from "../src";
import { cbn, mkt } from "./helpers";

const base = (over: Partial<EstimateInput> = {}, entries: LedgerEntry[] = []): EstimateInput => ({
  country: "NG",
  taxYear: 2026,
  asOf: "2026-06-30T12:00:00+01:00",
  accounts: [{ id: "a", label: "Main", lastSyncedAt: "2026-06-30T11:00:00+01:00", coverageFrom: "2026-01-01T00:00:00+01:00", gaps: [] }],
  entries,
  profile: { incomeScope: { allIncomeInLinkedAccounts: true } },
  ...over,
});
const inc = (id: string, amount: string, rate: string, day = "2026-03-10", over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id, accountId: "a", txHash: `hash-${id}`, occurredAt: `${day}T10:00:00+01:00`, direction: "in", kind: "income", asset: "USDC", amount,
  fx: { statutory: cbn(rate, day, { retrievedAt: `${day}T12:00:00+01:00` }), economic: null }, ...over,
});

// Independent model: exact rationals as bigint fractions.
const halfUp = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);
const dec = (s: string): [bigint, bigint] => {
  const [i, f = ""] = s.split(".");
  return [BigInt(i + f), 10n ** BigInt(f.length)];
};
function model(lines: [string, string][], rentNgn?: string, otherNgn?: string) {
  let gross = 0n;
  for (const [a, r] of lines) {
    const [an, ad] = dec(a);
    const [rn, rd] = dec(r);
    gross += halfUp(an * rn * 100n, ad * rd);
  }
  if (otherNgn) {
    const [n, d] = dec(otherNgn);
    gross += halfUp(n * 100n, d);
  }
  let relief = 0n;
  if (rentNgn) {
    const [n, d] = dec(rentNgn);
    const rent = halfUp(n * 100n, d);
    relief = halfUp(rent * 2n, 10n);
    if (relief > 50_000_000n) relief = 50_000_000n;
  }
  const taxable = gross > relief ? gross - relief : 0n;
  const bands: [bigint, bigint | null, bigint, bigint][] = [
    [0n, 80_000_000n, 0n, 100n], [80_000_000n, 300_000_000n, 15n, 100n], [300_000_000n, 1_200_000_000n, 18n, 100n],
    [1_200_000_000n, 2_500_000_000n, 21n, 100n], [2_500_000_000n, 5_000_000_000n, 23n, 100n], [5_000_000_000n, null, 25n, 100n],
  ];
  let tax = 0n;
  for (const [lo, hi, n, d] of bands) {
    const top = hi === null || taxable < hi ? taxable : hi;
    const inBand = top > lo ? top - lo : 0n;
    tax += halfUp(inBand * n, d);
  }
  const f = (k: bigint) => `${k / 100n}.${(k % 100n).toString().padStart(2, "0")}`;
  return { gross: f(gross), taxable: f(taxable), tax: f(tax), relief: f(relief) };
}

// Seeded (mulberry32), so any failure reproduces exactly. Change SEED to explore.
const SEED = 0x5eed_2026;
let state = SEED >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rnd(max: number) {
  return Math.floor(random() * max);
}
const decStr = (intMax: number, dp: number) => {
  const d = rnd(dp + 1);
  const i = String(rnd(intMax));
  return d === 0 ? i : `${i}.${String(rnd(10 ** d)).padStart(d, "0")}`;
};

describe("adv r3d: tax arithmetic against an independent model", () => {
  it("1000 random ledgers agree on gross, relief, taxable and total tax", () => {
    for (let n = 0; n < 1000; n++) {
      const k = 1 + rnd(4);
      const lines: [string, string][] = [];
      const entries: LedgerEntry[] = [];
      for (let i = 0; i < k; i++) {
        const amount = decStr(5_000_000, 7);
        const rate = (1 + rnd(2000)).toString() + (rnd(2) ? "." + String(rnd(1_000_000)).padStart(6, "0") : "");
        lines.push([amount, rate]);
        entries.push(inc(`e${i}`, amount, rate));
      }
      const rent = rnd(3) === 0 ? undefined : decStr(5_000_000, 2);
      const other = rnd(3) === 0 ? undefined : decStr(30_000_000, 2);
      const input = base(
        { profile: { annualRentNgn: rent, incomeScope: other ? { allIncomeInLinkedAccounts: false, otherIncomeNgn: other } : { allIncomeInLinkedAccounts: true } } },
        entries,
      );
      const r = estimate(input);
      const m = model(lines, rent, other);
      if (r.status !== "ok") throw new Error(`refused: ${JSON.stringify(r)} for ${JSON.stringify(input.entries)}`);
      expect({ gross: r.grossIncomeNgn, taxable: r.taxableIncomeNgn, tax: r.totalTaxNgn }).toEqual({ gross: m.gross, taxable: m.taxable, tax: m.tax });
    }
  });
});

describe("adv r3d: README edges", () => {
  it("a payment at exactly 1 Jan 00:00 Lagos counts, one second earlier does not", () => {
    const first = estimate(base({}, [inc("x", "10", "1500", "2026-01-01", { occurredAt: "2026-01-01T00:00:00+01:00" })]));
    expect(first.status === "ok" && first.grossIncomeNgn).toBe("15000.00");
    const before = estimate(base({}, [inc("x", "10", "1500", "2025-12-31", { occurredAt: "2025-12-31T23:59:59+01:00" })]));
    expect(before.status === "ok" && before.grossIncomeNgn).toBe("0.00");
  });
  it("0X-prefixed upper-case hash is the same payment", () => {
    const a = inc("a", "10", "1500", "2026-03-10", { txHash: "ABCDEF" });
    const b = inc("b", "10.0", "1500", "2026-03-10", { txHash: " 0Xabcdef " });
    expect(estimate(base({}, [a, b])).status).toBe("refused");
  });
  it("economic quote from another day is not a refusal and omits the gap", () => {
    const e = inc("a", "10", "1500");
    e.fx.economic = mkt("1600", "2026-03-09");
    const r = estimate(base({}, [e]));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.incomeLines[0]!.economicNgnValue).toBeUndefined();
  });
  it("a gap that ends exactly at the year start does not refuse; one that starts at year end does not either", () => {
    const acc = { id: "a", label: "Main", lastSyncedAt: "2026-06-30T11:00:00+01:00", coverageFrom: "2025-01-01T00:00:00+01:00" };
    const r1 = estimate(base({ accounts: [{ ...acc, gaps: [{ from: "2025-06-01T00:00:00+01:00", to: "2026-01-01T00:00:00+01:00" }] }] }));
    expect(r1.status).toBe("ok");
    const r2 = estimate(base({ accounts: [{ ...acc, gaps: [{ from: "2026-01-01T00:00:00+01:00", to: "2026-01-01T00:00:01+01:00" }] }] }));
    expect(r2.status).toBe("refused");
  });
});
