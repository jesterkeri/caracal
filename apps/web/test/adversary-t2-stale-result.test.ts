// Adversary t2: the tax page keeps showing a result after the person changed
// what they entered.
//
// Promise (docs/decisions.md 2026-11-27 and the page's own text): the estimate
// is "Estimate made <time>" for the answers the person gave (the income
// question, the income that arrives elsewhere, the rent). Goal 5 of this pass:
// "a result shown that no longer matches what they entered".
//
// The page keeps `run` = { kind: "done", outcome } when the income answer, the
// elsewhere amount or the rent are edited, so a tax number worked out with rent
// N600,000 stays on screen next to a rent box that now says N0 or N5,000,000.
//
// The page is rendered by calling the component with React's state and effects
// replaced by a small store (as adversary-r4a-pages does), so the real page code
// runs. The server answer is the repo's own pipeline run on a constructed
// payment (the t1 harness), served from a stubbed fetch: no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTaxEstimate } from "./tax-classify-harness";
import { WALLET, chain, deps, payment } from "./adversary-t1-harness";
import { cleanUp, mountTaxPage, walk } from "./adversary-t2-page-harness";

afterEach(cleanUp);


describe("adversary t2: a result stays on screen after the person changes their answers", () => {
  const answer = async () => {
    const c = chain([payment("2026-11-25T10:00:00Z", 10_000_000_000)]);
    const outcome = await runTaxEstimate({ wallet: WALLET, annualRentNgn: "600000", otherIncome: { kind: "all-in-caracal" } }, deps(c));
    return outcome;
  };

  it("control: after Estimate the page shows the result for the rent that was typed", async () => {
    const outcome = await answer();
    expect(outcome.status).toBe("ok");
    const posted: string[] = [];
    const { render, settle, ResultView } = await mountTaxPage(async (_u, init) => {
      posted.push(init.body);
      return Response.json(outcome);
    });
    const radios = walk(render(), (e) => e.type === "input" && e.props.type === "radio");
    (radios[0]!.props.onChange as () => void)();
    const rent = walk(render(), (e) => e.type === "input" && e.props.placeholder === "600000")[0]!;
    (rent.props.onChange as (e: unknown) => void)({ target: { value: "600000" } });
    const button = walk(render(), (e) => e.type === "button")[0]!;
    await (button.props.onClick as () => Promise<void>)();
    await settle();
    expect(JSON.parse(posted[0]!).annualRentNgn).toBe("600000");
    expect(walk(render(), (e) => e.type === ResultView)).toHaveLength(1);
  });

  it.each([
    ["the rent", (render: () => unknown) => (walk(render(), (e) => e.type === "input" && e.props.placeholder === "600000")[0]!.props.onChange as (e: unknown) => void)({ target: { value: "5000000" } })],
    ["the income answer", (render: () => unknown) => (walk(render(), (e) => e.type === "input" && e.props.type === "radio")[1]!.props.onChange as () => void)()],
  ])("does not keep showing the old result after %s is changed", async (_name, edit) => {
    const outcome = await answer();
    const { render, settle, ResultView } = await mountTaxPage(async () => Response.json(outcome));
    (walk(render(), (e) => e.type === "input" && e.props.type === "radio")[0]!.props.onChange as () => void)();
    (walk(render(), (e) => e.type === "input" && e.props.placeholder === "600000")[0]!.props.onChange as (e: unknown) => void)({ target: { value: "600000" } });
    await (walk(render(), (e) => e.type === "button")[0]!.props.onClick as () => Promise<void>)();
    await settle();
    expect(walk(render(), (e) => e.type === ResultView)).toHaveLength(1);
    edit(render);
    // The number on screen was worked out for answers the person has since replaced.
    expect(walk(render(), (e) => e.type === ResultView)).toHaveLength(0);
  });
});
