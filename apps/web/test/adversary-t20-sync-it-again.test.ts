// Adversary t20 (1): when the Stellar RPC's newest ledger is more than an hour old, the refusal tells the person
// "Account "Your Caracal split contract (Stellar testnet)" was last synced at ..., which is too old. Sync it again."
//
// Promises: docs/decisions.md 2026-11-27 (Codex tax R1): the estimate's stale limit is 1 hour so it "cannot be much
// later than the ledger it covers"; and the pipeline's own rule (lib/tax/pipeline.ts header): "Everything that can
// fail refuses" with a plain reason. The cause here is the network side (the RPC's newest ledger close time is old:
// a halted or lagging testnet, a stuck RPC). The person has no account to sync and the page has no sync control, so the
// engine's wording blames the person's account and offers a control that does not exist (a dead end and a wrong cause).
// The engine's reason is passed to the page unchanged (pipeline.ts: `reasons: [...ownReasons, ...result.reasons]`).
// Chain answers are CONSTRUCTED in the real Soroban RPC wire format (the t1 harness encoder). The only change to the
// harness chain is the newest ledger's close time (unix seconds), as the t8 and tax-pipeline stale-chain cases do.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultView } from "../src/app/tax/result-view";
import { chain, deps, payment, req, unix } from "./adversary-t1-harness";
import { runTaxEstimate } from "./tax-classify-harness";

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

/** The harness chain, with the RPC's newest ledger closed at `headClosedAt` (NOW in the harness is 2026-11-27T15:00:00Z). */
function chainWithHead(headClosedAt: string) {
  const items = [payment("2026-11-25T21:17:43Z", 10_000_000_000)];
  const c = chain(items);
  const set = <T extends { latestLedgerCloseTime: string }>(page: T): T => ({ ...page, latestLedgerCloseTime: unix(headClosedAt) });
  return {
    ...c,
    health: async () => set(await c.health()),
    events: async (...a: Parameters<typeof c.events>) => set(await c.events(...a)),
    eventsAfter: async (...a: Parameters<typeof c.eventsAfter>) => set(await c.eventsAfter(...a)),
  };
}

describe("adversary t20: a stale RPC head is not the person's account to sync", () => {
  it("control: a head closed 30 seconds ago gives an estimate", async () => {
    const out = await runTaxEstimate(req, deps(chainWithHead("2026-11-27T14:59:30Z")));
    expect(out.status).toBe("ok");
  });

  it("control: a head closed two hours ago is refused, with no number", async () => {
    const out = await runTaxEstimate(req, deps(chainWithHead("2026-11-27T13:00:00Z")));
    expect(out.status).toBe("refused");
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|grossIncomeNgn/);
  });

  it("does not tell the person to sync an account they cannot sync", async () => {
    const out = await runTaxEstimate(req, deps(chainWithHead("2026-11-27T13:00:00Z")));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    const shown = text(renderToStaticMarkup(ResultView({ outcome: out })));
    expect(shown).not.toMatch(/sync (it|the account|them|again)/i);
  });

  it("names the real cause: the network's newest ledger is old", async () => {
    const out = await runTaxEstimate(req, deps(chainWithHead("2026-11-27T13:00:00Z")));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).toMatch(/ledger|network|RPC/i);
  });
});
