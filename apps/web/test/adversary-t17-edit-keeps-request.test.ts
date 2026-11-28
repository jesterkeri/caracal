// Adversary t17: the tax page drops an estimate it has abandoned, but never cancels the request, so the server
// keeps reading the chain and the CBN list for an answer nobody will see.
//
// Promise: app/tax/page.tsx `edited()` says a changed answer makes "any result (or one still being worked out)
// stale: it is cleared". docs/decisions.md 2026-11-28 (Codex tax R4 #2) and lib/tax/deadline.ts: "the caller going
// away aborts every network read, so no work goes on after" the page stopped waiting. The page's own `stop`
// AbortController is only aborted by its 2 minute timer, never when the person edits an answer, so the request
// stays open (and keeps counting against the route's 6 a minute limit) for up to the server's 100 s deadline.
//
// The real /tax page is rendered with the repo's harness (as adversary-t2-stale-result does). No network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanUp, mountTaxPage, walk } from "./adversary-t2-page-harness";

afterEach(() => {
  vi.restoreAllMocks();
  cleanUp();
});

/** Starts an estimate that the server never answers, and returns the signal the page gave fetch. */
async function startSilentEstimate() {
  const seen: AbortSignal[] = [];
  const { render, settle } = await mountTaxPage((_u, init) => {
    seen.push((init as unknown as { signal: AbortSignal }).signal);
    return new Promise<Response>(() => {});
  });
  (walk(render(), (e) => e.type === "input" && e.props.type === "radio")[0]!.props.onChange as () => void)();
  void (walk(render(), (e) => e.type === "button")[0]!.props.onClick as () => Promise<void>)();
  await settle();
  return { render, settle, seen };
}

describe("adversary t17: an estimate the person has replaced is still being worked out by the server", () => {
  it("control: Estimate sends one request, its signal is live, and the page shows it working", async () => {
    const { render, seen } = await startSilentEstimate();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(false);
    const button = walk(render(), (e) => e.type === "button")[0]!;
    expect(button.props.disabled).toBe(true);
  });

  it("control: the page does drop the stale answer when an answer is edited (button free again)", async () => {
    const { render } = await startSilentEstimate();
    (walk(render(), (e) => e.type === "input" && e.props.placeholder === "600000")[0]!.props.onChange as (e: unknown) => void)({ target: { value: "5000000" } });
    expect(walk(render(), (e) => e.type === "button")[0]!.props.disabled).toBe(false);
  });

  it("cancels the request in flight when the person edits an answer, so the server stops", async () => {
    const { render, seen } = await startSilentEstimate();
    (walk(render(), (e) => e.type === "input" && e.props.placeholder === "600000")[0]!.props.onChange as (e: unknown) => void)({ target: { value: "5000000" } });
    // The page no longer waits for it (control above), so the request must not be left open.
    expect(seen[0]!.aborted).toBe(true);
  });
});
