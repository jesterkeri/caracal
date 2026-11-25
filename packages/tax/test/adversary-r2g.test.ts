import { describe, expect, it } from "vitest";
import { cbn, mkt } from "./helpers";
import { estimate } from "../src";
import type { Account, EstimateInput, LedgerEntry } from "../src";

const acct: Account = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };
const inc = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T05:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10000",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over });
const inp = (entries: unknown[], over: Record<string, unknown> = {}): EstimateInput =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts: [acct], profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over }) as EstimateInput;

const base = () => JSON.parse(JSON.stringify(inp([inc({ fx: { statutory: cbn("1500", "2026-05-10"), economic: mkt("1510", "2026-05-10") } })], {
  accounts: [{ ...acct, openedAt: "2025-01-01T00:00:00Z", gaps: [{ from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" }] }],
  profile: { annualRentNgn: "1000000", incomeScope: { allIncomeInLinkedAccounts: false, otherIncomeNgn: "5", otherIncomeNote: "x" } },
}))) as Record<string, any>;

function paths(o: unknown, pre: (string | number)[] = []): (string | number)[][] {
  if (o === null || typeof o !== "object") return [pre];
  const out: (string | number)[][] = [pre];
  for (const k of Object.keys(o as object)) out.push(...paths((o as any)[k], [...pre, Array.isArray(o) ? Number(k) : k]));
  return out;
}
const weird: unknown[] = [null, 0, -1, 1.5, "", " ", "abc", true, false, [], {}, [null], [[]], { a: 1 }, "2026-05-10", NaN, Infinity, "1e5", 1e400];

describe("adv r2g tax", () => {
  it("fuzz: untyped JSON never throws", () => {
    const thrown: string[] = [];
    for (const p of paths(base())) {
      if (p.length === 0) continue;
      for (const w of weird) {
        const b = base();
        let o: any = b;
        for (const k of p.slice(0, -1)) o = o[k];
        o[p[p.length - 1]!] = w;
        try { estimate(b as EstimateInput); } catch (e) { thrown.push(`${p.join(".")}=${String(w)} -> ${(e as Error).message}`); }
      }
      const b = base();
      let o: any = b;
      for (const k of p.slice(0, -1)) o = o[k];
      if (!Array.isArray(o)) { delete o[p[p.length - 1]!]; try { estimate(b as EstimateInput); } catch (e) { thrown.push(`del ${p.join(".")} -> ${(e as Error).message}`); } }
    }
    expect(thrown).toEqual([]);
  });
  it("duplicate account ids must refuse", () => {
    const r = estimate(inp([inc()], { accounts: [acct, { ...acct, label: "Dup", lastSyncedAt: "2026-12-01T07:00:00Z" }] }));
    expect(r.status).toBe("refused");
  });
  it("accounts and entries with no id must refuse", () => {
    const { id: _i, ...a } = acct; const { accountId: _x, ...e } = inc();
    expect(estimate(inp([e], { accounts: [a] })).status).toBe("refused");
  });
});
