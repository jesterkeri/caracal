// Follow-up to adversary t10 (the fix's own checks): a date listed twice is one rate when the numbers are equal,
// however they are written, and a conflict when they differ in any digit.
import { describe, expect, it } from "vitest";
import { parseNfemTable } from "../src/lib/tax/cbn-rates";

const table = (a: string, b: string) => parseNfemTable([{ ratedate: "November-26-2026", weightedAvgRate: a }, { ratedate: "November-26-2026", weightedAvgRate: b }]);

describe("t10 follow-ups: one date listed twice", () => {
  it("equal numbers written differently are one rate, kept as first written", () => {
    for (const [a, b] of [["1500.5", "1500.50"], ["01500.5", "1500.500000"], ["1500", "1500.0"], ["0.5", "00.50"]] as const) {
      const t = table(a, b);
      expect(t.conflicting.has("2026-11-26"), `${a} ${b}`).toBe(false);
      expect(t.byDate.get("2026-11-26")).toBe(a);
    }
  });

  it("different numbers conflict", () => {
    for (const [a, b] of [["1500.5", "1500.51"], ["1500", "15000"], ["1500.000001", "1500"]] as const) {
      expect(table(a, b).conflicting.has("2026-11-26"), `${a} ${b}`).toBe(true);
    }
  });
});
