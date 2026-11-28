// Adversary t23. docs/decisions.md, 2026-11-28 row "Adversary t22": naira the person typed is "checked first, before
// the network is read", and refused unless it is "digits with optional kobo after a point". Kobo are two decimal
// places (packages/tax README: "more than 2 decimal places (MAX_NAIRA_INPUT_DP, kobo). It is refused, never
// rounded"). An amount with three decimal places is not kobo, yet it passes the pipeline's early check, so the whole
// chain and rate read is done for a request that can never produce a number, and the person is first asked to answer
// every payment and only then told the amount is wrong.
//
// Chain answers are constructed in the real Soroban RPC wire format (adversary-t1-harness); the CBN rates are the
// real captured rows in fixtures/tax/cbn-nfem-rates.json.
import { describe, expect, it } from "vitest";
import { parseTaxRequest, runTaxEstimate } from "../src/lib/tax/pipeline";
import type { ChainReader } from "../src/lib/tax/chain-payments";
import { chain, deps, payment, req } from "./adversary-t1-harness";

/** A chain that counts every read made on it. */
function counted(c: ChainReader): { chain: ChainReader; reads: () => number } {
  let n = 0;
  const wrap = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => (n++, f(...a));
  return {
    chain: { health: wrap(c.health), instance: wrap(c.instance), events: wrap(c.events), eventsAfter: wrap(c.eventsAfter), transaction: wrap(c.transaction), holdings: wrap(c.holdings) },
    reads: () => n,
  };
}

const item = payment("2026-11-25T10:00:00Z", 100_000_000);

describe("adversary t23: a naira amount with sub-kobo places is refused before the network is read", () => {
  it("control: commas are refused at once, naming the amount, with no chain read", async () => {
    const c = counted(chain([item]));
    const out = await runTaxEstimate({ ...req, annualRentNgn: "600,000" }, deps(c.chain));
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.reasons.join(" ")).toMatch(/rent/i);
    expect(c.reads()).toBe(0);
  });

  it("control: kobo (two places) are accepted and do reach the chain", async () => {
    const c = counted(chain([item]));
    await runTaxEstimate({ ...req, annualRentNgn: "600000.50" }, deps(c.chain));
    expect(c.reads()).toBeGreaterThan(0);
  });

  it("rent with three decimal places is refused at once, naming the rent, with no chain read", async () => {
    const c = counted(chain([item]));
    const out = await runTaxEstimate({ ...req, annualRentNgn: "600000.123" }, deps(c.chain));
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.reasons.join(" ")).toMatch(/rent/i);
    expect(c.reads()).toBe(0);
  });

  it("income elsewhere with three decimal places is refused at once, naming it, with no chain read", async () => {
    const c = counted(chain([item]));
    const out = await runTaxEstimate({ ...req, otherIncome: { kind: "elsewhere", amountNgn: "2500000.999" } }, deps(c.chain));
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.reasons.join(" ")).toMatch(/elsewhere/i);
    expect(c.reads()).toBe(0);
  });
});

// Follow-up from t23's suspicions: an amount over the request's text limit is refused for its length, not as "must be text".
describe("adversary t23 follow-up: a typed amount over the length limit", () => {
  const wallet = req.wallet;
  it("names the length for the rent and for income elsewhere", () => {
    const long = "1".repeat(201);
    const rent = parseTaxRequest({ wallet, annualRentNgn: long, otherIncome: { kind: "all-in-caracal" } });
    const other = parseTaxRequest({ wallet, otherIncome: { kind: "elsewhere", amountNgn: long } });
    expect(rent.ok || rent.message).toMatch(/longer than 200 characters/);
    expect(other.ok || other.message).toMatch(/longer than 200 characters/);
  });
});
