// Adversary t1: a payment whose payer (`from`) is the owner's own wallet is the
// person moving their own money, not income (packages/tax README: `own_transfer`
// is never income). The pipeline labels every split event `income`.
import { describe, expect, it } from "vitest";
import { runTaxEstimate } from "./tax-classify-harness";
import { WALLET, chain, deps, payment, req } from "./adversary-t1-harness";

describe("adversary t1: own payment", () => {
  it("control: a third party's 1,000 USDC payment is income", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)])));
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("1392248.10");
  });

  it("does not count the owner paying their own invoice from their own wallet as income", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000, WALLET)])));
    if (out.status === "ok") expect(out.estimate.grossIncomeNgn).toBe("0.00");
  });
});
