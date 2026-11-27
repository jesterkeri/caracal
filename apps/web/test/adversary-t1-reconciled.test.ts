// Adversary t1: USDC that reached the split contract without `deposit` and was
// then credited by `reconcile()` (event `reconciled`, contracts/split/README.md)
// is a payment into the contract. The tax page reads only `split` events, so it
// skips it silently and still shows a number for "all income arrives in my
// split contract". Either counting it or refusing is acceptable; a number that
// leaves it out is not.
import { describe, expect, it } from "vitest";
import { runTaxEstimate } from "../src/lib/tax/pipeline";
import { chain, deps, payment, reconciled, req } from "./adversary-t1-harness";

describe("adversary t1: reconciled income", () => {
  it("control: one 1,000 USDC deposit on 2026-11-25 gives N1,392,248.10 gross", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)])));
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("1392248.10");
  });

  it("does not show a number that silently leaves out 500 USDC the contract credited by reconcile", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000), reconciled("2026-11-25T22:00:00Z", 5_000_000_000)])));
    // 1,500 USDC at 1392.2481 would be N2,088,372.15. Anything "ok" must include it.
    if (out.status === "ok") expect(Number(out.estimate.grossIncomeNgn)).toBeGreaterThanOrEqual(2_088_372.15);
    else expect(out.status).not.toBe("no-contract");
  });
});
