// Adversary t20 (2): when the person answers "not income" for every payment, the result says "No income payments in
// 2026 were found in the history window." directly above a list of the 2026 payments that were found and left out.
//
// Promise: docs/decisions.md 2026-11-27 (Codex tax R1): payments answered "not income" are "shown in the result as
// left out by the person's own answer, not checked on chain" (pipeline.ts `excludedByAnswer`). The same screen must
// not also claim that no payments were found: they were found (the coverage card counts them), and the person
// excluded them. A false claim about what was read, the same kind as adversary t18's coverage wording.
// Chain answers are CONSTRUCTED in the real Soroban RPC wire format (the t1 harness encoder); the CBN rate is the
// real captured row for 2026-11-25 (fixtures/tax/cbn-nfem-rates.json).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultView } from "../src/app/tax/result-view";
import { runTaxEstimate as real, type TaxOutcome, type TaxRequest } from "../src/lib/tax/pipeline";
import { chain, deps, payment, req } from "./adversary-t1-harness";

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const NO_INCOME = /No income payments in 2026 were found/;

/** The page's two requests: the first lists the payments, the second answers each with `answer`. */
async function answered(answer: "income" | "not_income", payments: ReturnType<typeof payment>[]): Promise<TaxOutcome> {
  const d = deps(chain(payments));
  const first = await real(req, d);
  if (first.status !== "refused" || first.payments === undefined) throw new Error("expected the list of payments to answer for");
  const withAnswers: TaxRequest = { ...req, classifications: Object.fromEntries(first.payments.map((p) => [p.id, answer])) };
  return real(withAnswers, d);
}

describe("adversary t20: the 'no income payments found' line under payments the person excluded", () => {
  it("control: payments answered income are not described as absent", async () => {
    const out = await answered("income", [payment("2026-11-25T21:17:43Z", 10_000_000_000)]);
    expect(out.status).toBe("ok");
    expect(text(renderToStaticMarkup(ResultView({ outcome: out })))).not.toMatch(NO_INCOME);
  });

  it("control: a wallet with no payments at all is told none were found", async () => {
    const out = await real(req, deps(chain([])));
    expect(out.status).toBe("ok");
    expect(text(renderToStaticMarkup(ResultView({ outcome: out })))).toMatch(NO_INCOME);
  });

  it("does not say no payments were found while listing the payments the person left out", async () => {
    const out = await answered("not_income", [payment("2026-11-25T21:17:43Z", 10_000_000_000)]);
    expect(out.status).toBe("ok");
    const shown = text(renderToStaticMarkup(ResultView({ outcome: out })));
    // The same screen lists the payment that was found and left out, and counts it.
    expect(shown).toContain("Left out by your own answer");
    expect(shown).toContain("Payments found in that window: 1, of which 1 fall in 2026");
    expect(shown).not.toMatch(NO_INCOME);
  });
});
