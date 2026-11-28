// Adversary t21: the pipeline asks the person to say whether each payment was income BEFORE it checks whether any
// estimate can be made at all. For a split contract whose creation is not in the RPC's history window (any contract
// older than about a week, the normal case) no answer can ever produce a number: the creation cannot be proven. The
// person is still told "Answer for each payment and estimate again" and shown the list, does the work, and only then
// is told there is no creation record. The first refusal names a cause (unanswered payments) that is not what blocks
// the estimate, and its call to action is a control that cannot work.
//
// Promise: docs/decisions.md 2026-11-27 (Coverage row): "otherwise there is no `openedAt` and the estimate refuses";
// 2026-11-27 Codex tax R1 row: a payment with no answer "is a refusal with a plain reason and the list". The page's
// own copy (app/tax/page.tsx): "Caracal makes no estimate until every payment has an answer", which promises that
// answering leads to an estimate. Goal 4 and 5: a false cause, a dead end.
//
// Real pipeline, called directly (not through tax-classify-harness, which answers for the person and so hides the
// first refusal). Chain answers are constructed with the t1 harness encoder; the window start is what the real
// testnet RPC reported on 2026-11-27.
import { describe, expect, it } from "vitest";
import { SPLIT } from "../src/lib/stellar/config";
import { runTaxEstimate } from "../src/lib/tax/pipeline";
import { chain, deps, payment, req } from "./adversary-t1-harness";

const WINDOW_START = "2026-11-20T14:15:35Z";
// One chain for the whole file: the harness gives every payment() call a new event id.
const CHAIN = { ...chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], WINDOW_START), instance: async () => ({ kind: "wasm" as const, hash: SPLIT.wasmHash }) };
const noCreation = () => CHAIN;

describe("adversary t21: no answer can help, yet the person is asked for answers first", () => {
  it("control: once every payment is answered, the refusal names the missing creation record", async () => {
    const first = await runTaxEstimate(req, deps(noCreation()));
    expect(first.status).toBe("refused");
    if (first.status !== "refused" || first.payments === undefined) throw new Error("expected the list of payments to answer");
    const answered = { ...req, classifications: Object.fromEntries(first.payments.map((p) => [p.id, "income" as const])) };
    const second = await runTaxEstimate(answered, deps(noCreation()));
    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.reasons.join(" ")).toMatch(/creation/i);
  });

  it("the first refusal does not ask for answers while hiding that no answer can produce an estimate", async () => {
    const first = await runTaxEstimate(req, deps(noCreation()));
    expect(first.status).toBe("refused");
    if (first.status !== "refused") return;
    // Either the blocker is named at once, or the person is not asked to do work that cannot help.
    const namesBlocker = /creation/i.test(first.reasons.join(" "));
    const asksForAnswers = first.payments !== undefined && first.payments.length > 0;
    expect(namesBlocker || !asksForAnswers).toBe(true);
  });
});
