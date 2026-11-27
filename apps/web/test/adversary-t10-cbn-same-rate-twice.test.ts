// Adversary t10. The CBN lists some dates twice (fixtures/tax/cbn-nfem-rates.json: six real dates, each
// with the same rate in both rows). src/lib/tax/cbn-rates.ts says a date is conflicting only when it is
// "listed twice with different rates". Two rows that write the SAME rate differently ("1500.5" and
// "1500.50") are not different rates, yet the table compares the rate text, so the day is refused: no
// payment on it can be valued although the one official rate for it is proven.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNfemTable, quoteFor } from "../src/lib/tax/cbn-rates";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tax/cbn-nfem-rates.json", import.meta.url), "utf8")) as { rows: Record<string, string>[] };
const row = (ratedate: string, weightedAvgRate: string) => ({ ratedate, weightedAvgRate });
const T0 = "2026-11-27T15:00:00Z";

describe("a date the CBN lists twice with one rate", () => {
  it("control: the real duplicate rows (same text) give a rate, different rates are refused", () => {
    expect(quoteFor(parseNfemTable(fixture.rows), "2025-06-19", T0).ok).toBe(true);
    expect(quoteFor(parseNfemTable([row("November-26-2026", "1500.5"), row("November-26-2026", "1500.6")]), "2026-11-26", T0).ok).toBe(false);
  });

  it("gives the rate when both rows are the same number written with and without a trailing zero", () => {
    const q = quoteFor(parseNfemTable([row("November-26-2026", "1500.5"), row("November-26-2026", "1500.50")]), "2026-11-26", T0);
    expect(q.ok).toBe(true);
    if (q.ok) expect(Number(q.quote.ngnPerUnit)).toBe(1500.5);
  });
});
