// Codex tax R1 regression tests (findings 2, 3 and 4). Chain answers are CONSTRUCTED in the real RPC wire format
// by adversary-t1-harness.ts; the CBN rates are the real captured rows.
import { StrKey } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { POST } from "../src/app/tax/estimate/route";
import { ResultView, pct } from "../src/app/tax/result-view";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, type ChainReader } from "../src/lib/tax/chain-payments";
import { parseTaxRequest, runTaxEstimate, type TaxRequest } from "../src/lib/tax/pipeline";
import { runTaxEstimate as runWithAllIncome } from "./tax-classify-harness";
import { CONTRACT, WALLET, chain, cursorFor, deps, payment, req, unix } from "./adversary-t1-harness";

const OTHER_WALLET_OF_MINE = StrKey.encodeContract(Buffer.alloc(32, 7));
const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };

describe("finding 2: a different sender is not proof of income", () => {
  it("a transfer from another wallet of the same person, with no answer, gives no number and lists the payment", async () => {
    const mine = payment("2026-11-25T10:00:00Z", 10_000_000_000, OTHER_WALLET_OF_MINE);
    const out = await runTaxEstimate(req, deps(chain([mine])));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).toMatch(/not been marked as income or not income/);
    expect(out.payments).toHaveLength(1);
    expect(out.payments![0]).toMatchObject({ id: mine.event.id, date: "2026-11-25", amount: "1000.0000000", from: OTHER_WALLET_OF_MINE });
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|grossIncomeNgn|ngnValue/);
  });

  it("a refund answered 'not income' is left out of the estimate and listed as left out by the person's own answer", async () => {
    const sale = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const refund = payment("2026-11-24T10:00:00Z", 4_000_000_000, OTHER_WALLET_OF_MINE);
    const out = await runTaxEstimate({ ...req, classifications: { [sale.event.id]: "income", [refund.event.id]: "not_income" } }, deps(chain([sale, refund])));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.estimate.grossIncomeNgn).toBe("1392248.10");
    expect(out.estimate.incomeLines).toHaveLength(1);
    expect(out.context.excludedByAnswer.map((p) => p.id)).toEqual([refund.event.id]);
    const html = renderToStaticMarkup(ResultView({ outcome: out }));
    expect(html).toContain("Left out by your own answer");
    expect(html).toContain("400.0000000");
  });

  it("answering 'income' for the same payment counts it (the answer, not the sender, decides)", async () => {
    const p = payment("2026-11-25T10:00:00Z", 10_000_000_000, OTHER_WALLET_OF_MINE);
    const out = await runTaxEstimate({ ...req, classifications: { [p.event.id]: "income" } }, deps(chain([p])));
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("1392248.10");
  });

  it("one payment answered and one not: still no number", async () => {
    const a = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const b = payment("2026-11-24T10:00:00Z", 1_000_000_000);
    const out = await runTaxEstimate({ ...req, classifications: { [a.event.id]: "income" } }, deps(chain([a, b])));
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.payments?.map((p) => p.id).sort()).toEqual([a.event.id, b.event.id].sort());
  });

  it("an answer for a payment that is not on the list (unknown id, or an id of the owner's own transfer) is refused", async () => {
    const a = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const own = payment("2026-11-24T10:00:00Z", 1_000_000_000, WALLET);
    const unknown = await runTaxEstimate({ ...req, classifications: { [a.event.id]: "income", nope: "income" } }, deps(chain([a])));
    expect(unknown.status).toBe("refused");
    expect(unknown.status === "refused" && unknown.reasons.join(" ")).toMatch(/not one of your 2026 payments/);
    const ownId = await runTaxEstimate({ ...req, classifications: { [a.event.id]: "income", [own.event.id]: "not_income" } }, deps(chain([a, own])));
    expect(ownId.status).toBe("refused");
  });

  it("the owner's own transfers stay excluded without any answer", async () => {
    const own = payment("2026-11-24T10:00:00Z", 1_000_000_000, WALLET);
    const out = await runTaxEstimate(req, deps(chain([own])));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("0.00");
  });

  it("an out-of-year payment needs no answer", async () => {
    const old = payment("2025-12-20T10:00:00Z", 1_000_000_000);
    const out = await runTaxEstimate(req, deps(chain([old])));
    expect(out.status).toBe("ok");
  });

  it("the request carries the answers and validates them", () => {
    // Test change (adversary t25): the answers are keyed by RPC event ids, the only keys that can name a payment;
    // they were "a" and "b", which are now refused before the network is read. The checks are unchanged.
    const A = "0025441509360848896-0000000000";
    const B = "0025441513655808000-0000000001";
    const ok = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" }, classifications: { [A]: "income", [B]: "not_income" } };
    expect(parseTaxRequest(ok)).toMatchObject({ ok: true, req: { classifications: { [A]: "income", [B]: "not_income" } } });
    for (const bad of [{ a: "maybe" }, { a: true }, ["income"], null, "income", { ["x".repeat(65)]: "income" }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, "income"]))]) {
      expect(parseTaxRequest({ ...ok, classifications: bad })).toMatchObject({ ok: false });
    }
  });

  it("the route takes answers for up to 100 payments in one request and refuses a malformed answer with 400", async () => {
    const answers = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${String(5900000 + i).padStart(19, "0")}-0000000001`, "income"]));
    const post = (b: unknown) => POST(new Request("http://localhost/tax/estimate", { method: "POST", body: JSON.stringify(b) }));
    const bad = await post({ wallet: WALLET, otherIncome: { kind: "all-in-caracal" }, classifications: { a: "yes" } });
    expect(bad.status).toBe(400);
    // 100 answers are within the body limit (a 400 here would be the size limit, not the content).
    const body = JSON.stringify({ wallet: WALLET, otherIncome: { kind: "all-in-caracal" }, classifications: answers });
    expect(body.length).toBeGreaterThan(2_000);
    const big = await post({ wallet: WALLET, otherIncome: { kind: "all-in-caracal" }, classifications: answers });
    expect(big.status).not.toBe(400);
  });
});

/** A chain where `late` is recorded after the first event scan and before the holdings read completes. */
function landsBetweenScanAndHoldings(late: ReturnType<typeof payment>) {
  let landed = false;
  // Fixture changed with Codex tax R4 #1 (a recheck repeating an event the scan already read is refused): once a scan
  // has read the late payment, the reads after its cursor no longer return it, as a real RPC's would not.
  let scannedLate = false;
  const base = chain([late]);
  const c: ChainReader = {
    ...base,
    events: async (...a) => {
      const r = await base.events(...a);
      if (landed) scannedLate = true;
      return { ...r, events: landed ? r.events : [] };
    },
    // The payment lands while the holdings are read: the pots already include it (held == pots, balanced).
    holdings: async () => {
      landed = true;
      return { held: BigInt(0), pots: BigInt(0), ledger: 6000000 };
    },
    eventsAfter: async (...a) => {
      const r = await base.eventsAfter(...a);
      return { ...r, events: landed && !scannedLate ? [late.event] : [] };
    },
  };
  return c;
}

describe("finding 3: the cutoff is one stable ledger", () => {
  it("a payment recorded between the event scan and the holdings read is in the result, not silently missing", async () => {
    const late = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const r = await readSplitPayments(landsBetweenScanAndHoldings(late), want);
    expect(r.kind === "read" && r.payments.map((p) => p.eventId)).toEqual([late.event.id]);
  });

  it("the same, end to end: the estimate counts the late payment", async () => {
    const late = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const out = await runWithAllIncome(req, deps(landsBetweenScanAndHoldings(late)));
    expect(out.status === "ok" && out.estimate.grossIncomeNgn).toBe("1392248.10");
  });

  it("events that keep arriving never give a stable boundary: refused after a bounded number of reads", async () => {
    const late = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const base = chain([late]);
    let n = 0;
    let reads = 0;
    const c: ChainReader = {
      ...base,
      events: async (...a) => ((reads++, base.events(...a))),
      eventsAfter: async (...a) => ({ ...(await base.eventsAfter(...a)), events: [{ ...late.event, id: `${String(6000000 + ++n).padStart(19, "0")}-0000000001` }] }),
    };
    await expect(readSplitPayments(c, want)).rejects.toThrow(/kept arriving/);
    expect(reads).toBeLessThanOrEqual(10);
    // And the pipeline turns it into "no estimate", with no figure.
    const out = await runTaxEstimate(req, deps(c));
    expect(out.status).toBe("unavailable");
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|grossIncomeNgn/);
  });

  it("the coverage is the ledger and close time of the stable check, after the holdings read", async () => {
    const base = chain([]);
    const c: ChainReader = {
      ...base,
      // The recheck's cursor reaches the ledger it names as newest (Codex tax R3: a page whose cursor stops short of
      // its newest ledger does not cover it). Fixture changed with R3; before, the cursor stayed at 6000000.
      eventsAfter: async (...a) => ({ ...(await base.eventsAfter(...a)), latestLedger: 6000004, latestLedgerCloseTime: unix("2026-11-27T14:59:50Z"), cursor: "0025769820955869184-0000000000" }),
      // The holdings are read after that check, so at its ledger (Codex tax R2 #1: a holdings read must name its ledger).
      holdings: async (...a) => ({ ...(await base.holdings(...a)), ledger: 6000004 }),
    };
    const r = await readSplitPayments(c, want);
    expect(r.kind === "read" && [r.coverage.toLedger, r.coverage.to]).toEqual([6000004, "2026-11-27T14:59:50Z"]);
    const out = await runTaxEstimate(req, deps(c));
    expect(out.status === "ok" && out.context.coverage.to).toBe("2026-11-27T14:59:50Z");
  });

  it("an estimate whose covered ledger closed more than an hour before it was made is refused as stale", async () => {
    const base = chain([]);
    const c: ChainReader = { ...base, eventsAfter: async (...a) => ({ ...(await base.eventsAfter(...a)), latestLedgerCloseTime: unix("2026-11-27T13:00:00Z") }) };
    const out = await runTaxEstimate(req, deps(c));
    expect(out.status).toBe("refused");
  });

  it("the coverage text names the ledger and does not claim more than that", async () => {
    const out = await runTaxEstimate(req, deps(chain([])));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const html = renderToStaticMarkup(ResultView({ outcome: out }));
    expect(html).toContain("through ledger 6000000");
    expect(html).toContain("A payment recorded after that ledger is not in this");
    expect(html).not.toContain("no payment of the year can be missing");
  });
});

describe("finding 4: rates are shown as percentages", () => {
  it("pct is exact for fractions and basis points", () => {
    const cases: [string, string][] = [
      ["0.1000", "10%"],
      ["0.15", "15%"],
      ["0.075", "7.5%"],
      ["0.0675", "6.75%"],
      ["0.0001", "0.01%"],
      ["0", "0%"],
      ["0.00", "0%"],
      ["1", "100%"],
      ["0.18", "18%"],
      ["0.1234567", "12.34567%"],
    ];
    for (const [fraction, shown] of cases) expect(pct(fraction)).toBe(shown);
    expect(pct("abc")).toBe("abc");
  });

  it("the result shows the effective rate and every band rate with a % sign", async () => {
    const p = payment("2026-11-25T10:00:00Z", 10_000_000_000);
    const out = await runWithAllIncome(req as TaxRequest, deps(chain([p])));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const html = renderToStaticMarkup(ResultView({ outcome: out }));
    expect(html).toContain(`Effective rate ${pct(out.estimate.effectiveRate)}.`);
    expect(html).not.toContain(`Effective rate ${out.estimate.effectiveRate}.`);
    for (const b of out.estimate.bands) expect(html).toContain(`at ${pct(b.rate)}:`);
    expect(html).toMatch(/Effective rate [0-9.]+%\./);
  });
});

void cursorFor;
