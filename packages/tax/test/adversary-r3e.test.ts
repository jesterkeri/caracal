// Adversary r3e: seeded differential check of the naira figure against an
// independent rational-arithmetic computation (no shared helpers with src/).
import { describe, expect, it } from "vitest";
import { estimate } from "../src";
import { cbn } from "./helpers";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = (r: () => number, n: number) => Math.floor(r() * n);
const dec = (r: () => number, ip: number, dp: number) => {
  const i = String(1 + pick(r, 10 ** ip));
  const f = Array.from({ length: dp }, () => pick(r, 10)).join("");
  return dp ? `${i}.${f}` : i;
};
// value as exact rational n/d
const q = (s: string): [bigint, bigint] => {
  const [i, f = ""] = s.split(".");
  return [BigInt(i + f), 10n ** BigInt(f.length)];
};
const roundKobo = (n: bigint, d: bigint) => (2n * n * 100n + d) / (2n * d); // half up of n/d*100
const fmt = (k: bigint) => `${k / 100n}.${String(k % 100n).padStart(2, "0")}`;

const BANDS: [bigint, bigint | null, [bigint, bigint]][] = [
  [0n, 800000n, [0n, 1n]],
  [800000n, 3000000n, [15n, 100n]],
  [3000000n, 12000000n, [18n, 100n]],
  [12000000n, 25000000n, [21n, 100n]],
  [25000000n, 50000000n, [23n, 100n]],
  [50000000n, null, [25n, 100n]],
];

describe("adv r3e: differential naira figure", () => {
  it("1500 seeded random ledgers: gross, taxable and tax match an independent computation", () => {
    const r = rng(20261126);
    for (let t = 0; t < 1500; t++) {
      const n = 1 + pick(r, 4);
      const entries = [];
      let gross = 0n;
      for (let i = 0; i < n; i++) {
        const amount = dec(r, 1 + pick(r, 7), pick(r, 8)).replace(/(\.\d{7})\d+$/, "$1");
        const rate = dec(r, 4, pick(r, 7)).replace(/(\.\d{6})\d+$/, "$1");
        entries.push({
          id: `e${t}-${i}`,
          accountId: "a1",
          txHash: `${t.toString(16).padStart(4, "0")}${i}`.padEnd(64, "0"),
          occurredAt: "2026-06-10T12:00:00+01:00",
          direction: "in" as const,
          kind: "income" as const,
          asset: "USDC",
          amount,
          fx: { statutory: cbn(rate, "2026-06-10"), economic: null },
        });
      }
      for (const e of entries) {
        const [an, ad] = q(e.amount);
        const [rn, rd] = q(e.fx.statutory.ngnPerUnit);
        gross += roundKobo(an * rn, ad * rd);
      }
      const rentS = pick(r, 3) === 0 ? String(pick(r, 5_000_000)) : undefined;
      const otherS = pick(r, 3) === 0 ? `${pick(r, 9_000_000)}.${String(pick(r, 100)).padStart(2, "0")}` : undefined;
      if (otherS) gross += BigInt(otherS.replace(".", ""));
      let relief = 0n;
      if (rentS) {
        const raw = (BigInt(rentS) * 100n * 2n * 2n + 10n) / 20n; // 20% of rent, half up, in kobo
        relief = raw < 50_000_000n ? raw : 50_000_000n;
      }
      const taxable = gross > relief ? gross - relief : 0n;
      let tax = 0n;
      for (const [lo, hi, [rn, rd]] of BANDS) {
        const l = lo * 100n;
        const top = hi === null || taxable < hi * 100n ? taxable : hi * 100n;
        const inBand = top > l ? top - l : 0n;
        tax += (2n * inBand * rn + rd) / (2n * rd);
      }
      const res = estimate({
        country: "NG",
        taxYear: 2026,
        asOf: "2026-06-10T21:30:00+01:00",
        accounts: [{ id: "a1", label: "A", lastSyncedAt: "2026-06-10T21:00:00+01:00", coverageFrom: "2026-01-01T00:00:00+01:00", gaps: [] }],
        entries,
        profile: {
          ...(rentS ? { annualRentNgn: rentS } : {}),
          incomeScope: otherS ? { allIncomeInLinkedAccounts: false, otherIncomeNgn: otherS } : { allIncomeInLinkedAccounts: true },
        },
      } as never);
      if (res.status !== "ok") throw new Error(`case ${t} refused: ${JSON.stringify(res)}`);
      expect([t, res.grossIncomeNgn, res.taxableIncomeNgn, res.totalTaxNgn]).toEqual([t, fmt(gross), fmt(taxable), fmt(tax)]);
    }
  });
});
