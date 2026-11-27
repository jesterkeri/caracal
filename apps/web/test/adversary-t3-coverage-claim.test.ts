// Adversary t3: every number the tax page can show today comes from the
// "created event" path (docs/decisions.md 2026-11-27): the public RPC's window
// is about 7 days, so the window never covers the whole of 2026, and an estimate
// is made only because the contract's creation was proven inside the window.
// The result's coverage paragraph nevertheless tells the person "The estimate is
// only made when this window covers the whole of 2026", which is false for the
// very result it sits under.
// Chain answers are CONSTRUCTED in the real Soroban RPC wire format (the t1
// harness encoder); the window start 2026-11-20T14:15:35Z is what the real
// testnet RPC reported on 2026-11-27 (fixtures/tax/soroban-testnet-split-events.json).
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { runTaxEstimate } from "./tax-classify-harness";
import { ResultView } from "../src/app/tax/result-view";
import { WALLET, CONTRACT, chain, deps, payment, req, unix, type Item } from "./adversary-t1-harness";

const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");

/** A `created` v1 event, as contracts/split's constructor publishes it. */
function created(closedAt: string): Item {
  const ledger = 5800001;
  const entries: [string, xdr.ScVal][] = [
    ["goal_bps", nativeToScVal(1500, { type: "u32" })],
    ["owner", Address.fromString(WALLET).toScVal()],
    ["tax_bps", nativeToScVal(1000, { type: "u32" })],
    ["token", Address.fromString(TOKENS.usdc).toScVal()],
  ];
  const value = xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));
  return {
    event: { type: "contract", ledger, ledgerClosedAt: closedAt, contractId: CONTRACT, id: `${String(ledger).padStart(19, "0")}-0000000000`, txHash: "c".repeat(64), topic: [sym("created"), sym("v1")], value: value.toXDR("base64") },
    tx: { status: "SUCCESS", ledger, createdAt: unix(closedAt) },
  };
}

const WINDOW_START = "2026-11-20T14:15:35Z";
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("adversary t3: the coverage paragraph of an estimate", () => {
  it("control: a creation event inside a window that starts after 1 January yields a number", async () => {
    const out = await runTaxEstimate(req, deps(chain([created("2026-11-22T10:00:00Z"), payment("2026-11-25T21:17:43Z", 10_000_000_000)], WINDOW_START)));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.context.coverage.from).toBe(WINDOW_START);
    expect(Date.parse(out.context.coverage.from)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00+01:00"));
  });

  it("does not tell the person the estimate is only made when the window covers the whole year, when it was made on a window that does not", async () => {
    const out = await runTaxEstimate(req, deps(chain([created("2026-11-22T10:00:00Z"), payment("2026-11-25T21:17:43Z", 10_000_000_000)], WINDOW_START)));
    expect(out.status).toBe("ok");
    const shown = text(renderToStaticMarkup(ResultView({ outcome: out })));
    // The claim itself, as shown, with the window start the page prints.
    expect(shown).toContain("2026-11-20 14:15:35 UTC");
    const claimsFullYearWindow = /only made when this window covers the whole of 2026/.test(shown);
    const mentionsCreation = /creat/i.test(shown.slice(shown.indexOf("What this is based on")));
    expect(claimsFullYearWindow && !mentionsCreation).toBe(false);
  });
});
