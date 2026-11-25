import { describe, expect, it } from "vitest";
import { cbn, mkt } from "./helpers";
import { estimate } from "../src";

const base = (): any => ({
  country: "NG",
  taxYear: 2026,
  asOf: "2026-12-01T12:00:00Z",
  entries: [
    {
      id: "e1", accountId: "a1", txHash: "t1", occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income",
      asset: "USDC", amount: "100", fx: { statutory: cbn("1500", "2026-05-10"), economic: null },
    },
  ],
  accounts: [{ id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] }],
  profile: { incomeScope: { allIncomeInLinkedAccounts: true } },
});

const mutations: Record<string, (i: any) => any> = {
  "accounts missing": (i) => { delete i.accounts; return i; },
  "entries missing": (i) => { delete i.entries; return i; },
  "profile missing": (i) => { delete i.profile; return i; },
  "account gaps missing": (i) => { delete i.accounts[0].gaps; return i; },
  "entry fx missing": (i) => { delete i.entries[0].fx; return i; },
  "entry is null": (i) => { i.entries.push(null); return i; },
  "account is null": (i) => { i.accounts.push(null); return i; },
  "gap is null": (i) => { i.accounts[0].gaps.push(null); return i; },
  "input is null": () => null,
};

describe("r2f: untyped JSON must be refused, never thrown", () => {
  for (const [name, mut] of Object.entries(mutations)) {
    it(name, () => {
      const r = estimate(mut(base()));
      expect(r.status).toBe("refused");
    });
  }
});

describe("r2f: malformed economic quote is never silently dropped (README Refusal rules)", () => {
  for (const bad of [0, "", false]) {
    it(`economic ${JSON.stringify(bad)}`, () => {
      const i = base();
      i.entries[0].fx.economic = bad;
      expect(estimate(i).status).toBe("refused");
    });
  }
  it("sanity: valid economic ok", () => {
    const i = base();
    i.entries[0].fx.economic = mkt("1600", "2026-05-10");
    expect(estimate(i).status).toBe("ok");
  });
});
