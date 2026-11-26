// Codex r3 #4: the result must carry the USDC = USD assumption and the
// valuation basis, so a consumer showing only the result still shows them.
import { describe, expect, it } from "vitest";
import { estimate } from "../src";
import { getRules } from "../src/rules";
import { cbn } from "./helpers";

const input = (entries: unknown[]) =>
  ({
    country: "NG",
    taxYear: 2026,
    asOf: "2026-12-01T12:00:00Z",
    entries,
    accounts: [{ id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] }],
    profile: { incomeScope: { allIncomeInLinkedAccounts: true } },
  }) as never;
const income = (id: string) => ({
  id, accountId: "a1", txHash: `tx-${id}`, occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income",
  asset: "USDC", amount: "500", fx: { statutory: cbn("1500", "2026-05-10"), economic: null },
});

describe("valuation assumptions survive to the result (Codex r3 #4)", () => {
  const rules = getRules("NG", 2026)!;

  it("each income line names the basis and points to notes holding the exact rules text", () => {
    const r = estimate(input([income("1"), income("2")]));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const notes = new Map(r.informational.map((n) => [n.id, n]));
    for (const line of r.incomeLines) {
      expect(line.valuationBasis).toBe(rules.valuation.basis);
      expect(line.assumptionIds.length).toBeGreaterThan(0);
      for (const id of line.assumptionIds) expect(notes.has(id)).toBe(true);
    }
    const kinds = r.informational.map((n) => n.kind);
    expect(kinds.filter((k) => k === "valuation_basis")).toHaveLength(1);
    expect(kinds.filter((k) => k === "asset_assumption")).toHaveLength(1);
    expect(r.informational.find((n) => n.kind === "asset_assumption")!.message).toBe(rules.valuation.assetBaseNote);
    expect(r.informational.find((n) => n.kind === "valuation_basis")!.message).toContain(rules.valuation.note);
  });

  it("with no income lines there is nothing to qualify, so no assumption notes", () => {
    const r = estimate(input([]));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.informational.some((n) => n.kind === "asset_assumption" || n.kind === "valuation_basis")).toBe(false);
  });
});
