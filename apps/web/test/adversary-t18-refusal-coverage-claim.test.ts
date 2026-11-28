// Adversary t18: the coverage card under a REFUSED estimate still tells the person "no payment recorded up to that
// ledger is missing", in the same answer whose first reason says the payments before the window "cannot be read".
//
// Promise: docs/decisions.md 2026-11-27 (Adversary t3): the coverage note says an estimate is made when the window
// covers the year from its start or from the split contract's creation. The refusal for a contract with no creation
// record in the window (the usual refusal today: every contract older than the RPC's roughly 7 day window) is the
// case where that condition is NOT met, so the claim that nothing up to the covered ledger is missing is false for
// this very answer ("a claim of coverage stronger than what was read"). result-view.tsx `Coverage` is rendered for
// every outcome that carries a context, refused ones included.
// Chain answers are CONSTRUCTED in the real Soroban RPC wire format (the t1 harness encoder); the window start
// 2026-11-20T14:15:35Z is what the real testnet RPC reported on 2026-11-27 (fixtures/tax/soroban-testnet-split-events.json).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultView } from "../src/app/tax/result-view";
import { runTaxEstimate } from "./tax-classify-harness";
import { chain, deps, payment, req } from "./adversary-t1-harness";

const WINDOW_START = "2026-11-20T14:15:35Z";
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("adversary t18: the coverage card of a refusal for a window that does not cover the year", () => {
  it("control: a contract with no creation record in a window that starts in November is refused, with the reason on screen", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], WINDOW_START)));
    expect(out.status).toBe("refused");
    const shown = text(renderToStaticMarkup(ResultView({ outcome: out })));
    expect(shown).toContain("Payments before 2026-11-20T14:15:35Z cannot be read");
    // The coverage card is part of this refusal (the harness shows what the person sees).
    expect(shown).toContain("What this is based on");
    expect(shown).not.toMatch(/\bN\d/); // no naira figure
  });

  it("does not tell the person no payment up to the ledger is missing while the same answer says payments before the window cannot be read", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], WINDOW_START)));
    expect(out.status).toBe("refused");
    const shown = text(renderToStaticMarkup(ResultView({ outcome: out })));
    expect(shown).toContain("cannot be read");
    expect(shown).not.toMatch(/no payment recorded up to that ledger is missing/);
  });
});
