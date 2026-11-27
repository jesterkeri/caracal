// Adversary t2: a payment the owner made from their own wallet is not income
// (decisions.md 2026-11-27, tax page fixes (2): "never income"; packages/tax
// README: `own_transfer` is never income and is never valued). The pipeline
// still asks the CBN for a rate on the day of every in-year payment, own
// transfers included, so an own transfer made on a day CBN publishes no rate
// (a Saturday: 2026-11-21) refuses the whole estimate with "a payment on that
// day cannot be valued", although the only income (a third party's payment on
// 2026-11-25) has its CBN rate and nothing needs valuing on the 21st.
import { describe, expect, it } from "vitest";
import { runTaxEstimate } from "../src/lib/tax/pipeline";
import { WALLET, chain, deps, payment, req } from "./adversary-t1-harness";

const THIRD_PARTY_ON_WEDNESDAY = payment("2026-11-25T21:17:43Z", 10_000_000_000);

describe("adversary t2: own transfer on a day with no CBN rate", () => {
  it("control: a third party's payment on that Saturday is income that cannot be valued, so it refuses", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-21T10:00:00Z", 10_000_000_000), THIRD_PARTY_ON_WEDNESDAY])));
    expect(out.status).toBe("refused");
  });

  it("control: the same third party payment alone gives N1,392,248.10", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)])));
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("1392248.10");
  });

  it("does not refuse for a day on which the only payment is the owner's own transfer, which needs no rate", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-21T10:00:00Z", 10_000_000_000, WALLET), payment("2026-11-25T21:17:43Z", 10_000_000_000)])));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("1392248.10");
  });
});
