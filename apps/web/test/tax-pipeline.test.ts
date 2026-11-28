// From a wallet to an estimate. The CBN rates are the real captured rows
// (fixtures/tax/cbn-nfem-rates.json). The chain side is CONSTRUCTED here: the
// real contract's owner is not a passkey wallet, so a wallet's own payments
// cannot be captured; payments and a history window that covers the year are
// built in the real RPC wire format, and the window the real testnet RPC
// reported on 2026-11-27 (fixtures/tax/soroban-testnet-split-events.json) is
// used for the refusal case.
import { readFileSync } from "node:fs";
import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOT_ADVICE, ResultView } from "../src/app/tax/result-view";
import { TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { SPLIT } from "../src/lib/stellar/config";
import { parseNfemTable, RateSourceError } from "../src/lib/tax/cbn-rates";
import type { ChainReader, EventsPage, RawEvent } from "../src/lib/tax/chain-payments";
import { lagosDate, parseTaxRequest, unitsToDecimal, type PipelineDeps, type TaxRequest } from "../src/lib/tax/pipeline";
import { runTaxEstimate } from "./tax-classify-harness";

const rates = parseNfemTable((JSON.parse(readFileSync(new URL("./fixtures/tax/cbn-nfem-rates.json", import.meta.url), "utf8")) as { rows: unknown[] }).rows);
const realWindow = (JSON.parse(readFileSync(new URL("./fixtures/tax/soroban-testnet-split-events.json", import.meta.url), "utf8")) as { health: EventsPage }).health;

const WALLET = StrKey.encodeContract(Buffer.alloc(32, 9));
const CONTRACT = splitAddressFor(WALLET);
const NOW = new Date("2026-11-27T15:00:00Z");
const unix = (iso: string) => String(Date.parse(iso) / 1000);
const cursorFor = (ledger: number) => `${(BigInt(ledger) * BigInt(4294967296)).toString().padStart(19, "0")}-4294967295`;

const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
let seq = 0;
/** A split event for `units` USDC units that closed at `closedAt`. */
function payment(closedAt: string, units: number, owner = WALLET): { event: RawEvent; tx: { status: string; ledger: number; createdAt: string } } {
  const n = ++seq;
  const amount = BigInt(units);
  const tax = amount / BigInt(10);
  const goal = amount / BigInt(10);
  const ledger = 5900000 + n;
  const entries: [string, xdr.ScVal][] = [
    ["amount", i128(amount)],
    // A third party pays: a payer that is the owner's own wallet is not income (adversary t1).
    ["from", Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 5))).toScVal()],
    ["goal", i128(goal)],
    ["invoice_ref", xdr.ScVal.scvBytes(Buffer.from(`INV-${n}`))],
    ["owner", Address.fromString(owner).toScVal()],
    ["spend", i128(amount - tax - goal)],
    ["tax", i128(tax)],
    ["token", Address.fromString(TOKENS.usdc).toScVal()],
  ];
  const value = xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));
  return {
    event: { type: "contract", ledger, ledgerClosedAt: closedAt, contractId: CONTRACT, id: `${String(ledger).padStart(19, "0")}-0000000001`, txHash: String(n).padStart(64, "0"), topic: [sym("split"), sym("v1")], value: value.toXDR("base64") },
    tx: { status: "SUCCESS", ledger, createdAt: unix(closedAt) },
  };
}

/** A `created` v1 event (constructor event of contracts/split) that closed at `closedAt`; constructed in the real wire format. */
function created(closedAt: string, o: { owner?: string; token?: string; txStatus?: string } = {}): ReturnType<typeof payment> {
  const n = ++seq;
  const ledger = 5900000 + n;
  const entries: [string, xdr.ScVal][] = [
    ["goal_bps", nativeToScVal(1500, { type: "u32" })],
    ["owner", Address.fromString(o.owner ?? WALLET).toScVal()],
    ["tax_bps", nativeToScVal(1000, { type: "u32" })],
    ["token", Address.fromString(o.token ?? TOKENS.usdc).toScVal()],
  ];
  const value = xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));
  return {
    event: { type: "contract", ledger, ledgerClosedAt: closedAt, contractId: CONTRACT, id: `${String(ledger).padStart(19, "0")}-0000000000`, txHash: String(n).padStart(64, "0"), topic: [sym("created"), sym("v1")], value: value.toXDR("base64") },
    tx: { status: o.txStatus ?? "SUCCESS", ledger, createdAt: unix(closedAt) },
  };
}

/** A chain that has kept history since `oldest` and holds these payments. */
function chain(payments: ReturnType<typeof payment>[], oldest = "2025-12-01T00:00:00Z", over: Partial<ChainReader> = {}): ChainReader {
  const retention = { latestLedger: 6000000, oldestLedger: 5000000, latestLedgerCloseTime: unix("2026-11-27T14:59:30Z"), oldestLedgerCloseTime: unix(oldest) };
  return {
    health: async () => retention,
    instance: async () => ({ kind: "wasm", hash: SPLIT.wasmHash }),
    // Balanced: everything the contract holds is in its pots (holdings is a required read).
    holdings: async () => ({ held: BigInt(0), pots: BigInt(0), ledger: 6000000 }),
    events: async () => ({ ...retention, events: payments.map((p) => p.event), cursor: cursorFor(6000000) }),
    eventsAfter: async () => ({ ...retention, events: [], cursor: cursorFor(6000000) }),
    transaction: async (hash) => payments.find((p) => p.event.txHash === hash)!.tx,
    ...over,
  };
}

const deps = (c: ChainReader, over: Partial<PipelineDeps> = {}): PipelineDeps => ({ chain: c, rateTable: async () => rates, now: () => NOW, ...over });
const req: TaxRequest = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" } };

describe("the estimate, from payments the chain recorded (constructed) and real CBN rates", () => {
  it("values a payment at the CBN rate of its own day and runs the engine: 1,000 USDC on 2026-11-25", async () => {
    // 1,000 x 1392.2481 = N1,392,248.10; (1,392,248.10 - 800,000) x 15% = 88,837.215, half up to 88,837.22.
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)])));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const e = out.estimate;
    expect(e.grossIncomeNgn).toBe("1392248.10");
    expect(e.totalTaxNgn).toBe("88837.22");
    expect(e.disclaimer).toBe("This is an estimate, not tax advice.");
    const line = e.incomeLines[0]!;
    expect(line).toMatchObject({
      amount: "1000.0000000",
      asset: "USDC",
      ngnPerUnit: "1392.2481",
      rateProvider: "Central Bank of Nigeria",
      ratePair: "USD/NGN",
      rateDate: "2026-11-25",
      rateSourceUrl: "https://www.cbn.gov.ng/rates/ExchRateByCurrency.html",
      ngnValue: "1392248.10",
    });
    expect(line.ruleId).toBeTruthy();
    expect(e.sources.length).toBeGreaterThan(0);
    expect(out.context).toMatchObject({ taxYear: 2026, splitContract: CONTRACT, paymentsInWindow: 1, paymentsInTaxYear: 1 });
    expect(out.context.coverage.from).toBe("2025-12-01T00:00:00Z");

    // The page shows every line with its rule and source, and the disclaimer.
    const html = renderToStaticMarkup(ResultView({ outcome: out }));
    for (const needle of [NOT_ADVICE, "N1,392,248.10", "N88,837.22", line.ruleId, line.rateSourceUrl, "Central Bank of Nigeria", "2026-11-25", "secondary", ...e.bands.map((b) => b.ruleId), ...e.informational.map((i) => i.id)]) {
      expect(html).toContain(needle);
    }
    expect(html).not.toContain("\u2014");
  });

  it("uses the rate of the Lagos day: 23:30 UTC on 2026-11-25 is already 26 November in Nigeria", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T23:30:00Z", 10_000_000_000)])));
    expect(out.status === "ok" && out.estimate.incomeLines[0]!.rateDate).toBe("2026-11-26");
    expect(out.status === "ok" && out.estimate.incomeLines[0]!.ngnPerUnit).toBe("1387.8883");
  });

  it("a payment on the 1 January 2026 holiday has no CBN rate, so there is no estimate", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-01-01T10:00:00Z", 10_000_000_000)])));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).toContain("2026-01-01");
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|grossIncomeNgn/);
  });

  it("a payment on a Saturday refuses, even when other payments could be valued", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T10:00:00Z", 10_000_000_000), payment("2026-11-21T10:00:00Z", 10_000_000)])));
    // 21 November 2026 was a Saturday: CBN published no rate for it.
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reasons.join(" ")).toContain("2026-11-21");
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|ngnValue/);
  });

  it("a payment at 23:30 UTC on 31 December 2026 is 2027 income in Nigeria: not counted, and it needs no rate", async () => {
    const p = payment("2026-12-31T23:30:00Z", 10_000_000_000);
    const base = chain([p]);
    const h = { ...(await base.health()), latestLedgerCloseTime: unix("2027-02-01T09:59:30Z") };
    let asked = false;
    const out = await runTaxEstimate(
      req,
      deps({ ...base, health: async () => h, events: async (...a) => ({ ...(await base.events(...a)), latestLedgerCloseTime: h.latestLedgerCloseTime }), eventsAfter: async (...a) => ({ ...(await base.eventsAfter(...a)), latestLedgerCloseTime: h.latestLedgerCloseTime }) }, { now: () => new Date("2027-02-01T10:00:00Z"), rateTable: async () => ((asked = true), rates) }),
    );
    expect(asked).toBe(false);
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && [out.estimate.grossIncomeNgn, out.context.paymentsInWindow, out.context.paymentsInTaxYear]).toEqual(["0.00", 1, 0]);
  });

  it("with no payments in the year it asks CBN for nothing and returns a proven zero", async () => {
    let asked = false;
    const out = await runTaxEstimate(req, deps(chain([]), { rateTable: async () => ((asked = true), rates) }));
    expect(asked).toBe(false);
    expect(out.status === "ok" && out.estimate.totalTaxNgn).toBe("0.00");
  });

  it("adds income the person says arrives elsewhere, labelled as declared, and applies rent relief", async () => {
    const out = await runTaxEstimate(
      { wallet: WALLET, annualRentNgn: "600000", otherIncome: { kind: "elsewhere", amountNgn: "2000000", note: "a salary" } },
      deps(chain([])),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.estimate.grossIncomeNgn).toBe("2000000.00");
    expect(out.estimate.declaredIncomeLines[0]).toMatchObject({ amountNgn: "2000000.00", source: "declared by you" });
    expect(out.estimate.reliefs[0]!.amountNgn).toBe("120000.00");
  });

  it("passes the engine's own refusal for bad typed amounts (more than 2 decimals) instead of rounding", async () => {
    const out = await runTaxEstimate({ wallet: WALLET, otherIncome: { kind: "elsewhere", amountNgn: "100.001" } }, deps(chain([])));
    expect(out.status).toBe("refused");
  });
});

describe("refusing to guess", () => {
  it("refuses the 2026 year on the history window the public testnet RPC really reported on 2026-11-27 (it starts 20 November)", async () => {
    const retention = { ...realWindow, latestLedgerCloseTime: unix("2026-11-27T14:59:30Z") };
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000)], "2026-11-20T14:15:35Z", { health: async () => retention })));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).toMatch(/coverage|history/i);
    expect(out.context?.coverage.from).toBe("2026-11-20T14:15:35Z");
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|grossIncomeNgn|ngnValue/);
  });

  it("refuses when the history window starts one second after the tax year starts", async () => {
    const out = await runTaxEstimate(req, deps(chain([], "2025-12-31T23:00:01Z")));
    expect(out.status).toBe("refused");
  });

  it("accepts a window that starts exactly when the tax year starts (2026-01-01 00:00 in Nigeria)", async () => {
    const out = await runTaxEstimate(req, deps(chain([], "2025-12-31T23:00:00Z")));
    expect(out.status).toBe("ok");
  });

  it("refuses when the chain was last read more than a day ago", async () => {
    const stale = chain([]);
    const h = await stale.health();
    const out = await runTaxEstimate(req, deps({ ...stale, health: async () => ({ ...h, latestLedgerCloseTime: unix("2026-11-26T10:00:00Z") }), events: async (...a) => ({ ...(await stale.events(...a)), latestLedgerCloseTime: unix("2026-11-26T10:00:00Z") }), eventsAfter: async (...a) => ({ ...(await stale.eventsAfter(...a)), latestLedgerCloseTime: unix("2026-11-26T10:00:00Z") }) }));
    expect(out.status).toBe("refused");
  });

  it("says nothing numeric when the CBN list cannot be read, and names why", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000)]), { rateTable: async () => { throw new RateSourceError("Caracal could not reach the CBN rate list."); } }));
    expect(out.status).toBe("unavailable");
    expect(out.status === "unavailable" && out.message).toMatch(/CBN/);
    expect(JSON.stringify(out)).not.toMatch(/ngnValue|totalTaxNgn/);
  });

  it("says nothing numeric when the chain cannot be read", async () => {
    const out = await runTaxEstimate(req, deps(chain([], undefined, { health: async () => { throw new (await import("../src/lib/tax/chain-payments")).ChainReadError("Caracal could not reach the Stellar RPC."); } })));
    expect(out.status).toBe("unavailable");
  });

  it("says nothing numeric when a payment belongs to another owner", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000, StrKey.encodeContract(Buffer.alloc(32, 3)))])));
    expect(out.status).toBe("unavailable");
  });

  it("reports a wallet with no split contract, with no numbers", async () => {
    const out = await runTaxEstimate(req, deps(chain([], undefined, { instance: async () => ({ kind: "absent" }) })));
    expect(out).toMatchObject({ status: "no-contract", splitContract: CONTRACT });
  });

  it("refuses two payments that look like the same one (same transaction and amount)", async () => {
    const p = payment("2026-11-25T21:17:43Z", 10_000_000);
    const second = { ...p, event: { ...p.event, id: `${p.event.id}x` } };
    const out = await runTaxEstimate(req, deps(chain([p, second])));
    expect(out.status).toBe("refused");
  });

  it("never lets a rate that is not the CBN's through: the quotes it builds are the engine's checked kind", async () => {
    const forged = parseNfemTable([{ ratedate: "November-25-2026", weightedAvgRate: "1392.2481" }]);
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000)]), { rateTable: async () => forged }));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.incomeLines[0]!.rateSourceUrl.startsWith("https://www.cbn.gov.ng/")).toBe(true);
  });
});

describe("proving when the contract was created (the created event)", () => {
  const WINDOW_START = "2026-11-20T14:15:35Z"; // what the real testnet RPC reported on 2026-11-27
  const big = 10_000_000_000; // 1,000 USDC

  it("a creation event inside the window makes the estimate possible although the window starts after 1 January", async () => {
    const out = await runTaxEstimate(req, deps(chain([created("2026-11-22T10:00:00Z"), payment("2026-11-25T21:17:43Z", big)], WINDOW_START)));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.totalTaxNgn).toBe("88837.22");
    expect(out.status === "ok" && out.context.coverage.from).toBe(WINDOW_START);
  });

  it("with no creation event the contract may be older than the window: refused with a plain reason, no numbers", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", big)], WINDOW_START)));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons[0]).toBe(
      "No record of the split contract's creation was found in the RPC's history window of about a week, so the contract was created before that window. Payments before 2026-11-20T14:15:35Z cannot be read. A payment indexer is needed to read the whole of 2026.",
    );
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|ngnValue|grossIncomeNgn/);
  });

  it("does not add that reason when the window itself covers the year", async () => {
    const out = await runTaxEstimate({ ...req, otherIncome: { kind: "elsewhere", amountNgn: "1.001" } }, deps(chain([], "2025-12-01T00:00:00Z")));
    expect(out.status === "refused" && out.reasons.join(" ")).not.toContain("history window of about a week");
  });

  it("refuses a payment dated before the creation event (the engine's openedAt check)", async () => {
    const out = await runTaxEstimate(req, deps(chain([created("2026-11-24T10:00:00Z"), payment("2026-11-23T10:00:00Z", big)], WINDOW_START)));
    expect(out.status).toBe("refused");
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|ngnValue/);
  });

  it("refuses two creation events, with no numbers", async () => {
    const out = await runTaxEstimate(req, deps(chain([created("2026-11-22T10:00:00Z"), created("2026-11-23T10:00:00Z"), payment("2026-11-25T21:17:43Z", big)], WINDOW_START)));
    expect(out).toMatchObject({ status: "unavailable" });
    expect(out.status === "unavailable" && out.message).toMatch(/more than one creation event/);
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn|ngnValue/);
  });

  it("refuses a creation event naming another owner or another token", async () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 3));
    for (const c of [created("2026-11-22T10:00:00Z", { owner: other }), created("2026-11-22T10:00:00Z", { token: TOKENS.xlm })]) {
      const out = await runTaxEstimate(req, deps(chain([c, payment("2026-11-25T21:17:43Z", big)], WINDOW_START)));
      expect(out.status).toBe("unavailable");
    }
  });

  it("refuses a creation event whose transaction did not succeed", async () => {
    const out = await runTaxEstimate(req, deps(chain([created("2026-11-22T10:00:00Z", { txStatus: "FAILED" }), payment("2026-11-25T21:17:43Z", big)], WINDOW_START)));
    expect(out.status).toBe("unavailable");
    expect(out.status === "unavailable" && out.message).toMatch(/could not be confirmed/);
  });

  it("refuses a creation event of an unknown version or with unreadable data", async () => {
    const v2 = created("2026-11-22T10:00:00Z");
    v2.event.topic = [sym("created"), sym("v2")];
    const junk = created("2026-11-22T10:00:00Z");
    junk.event.value = "AAAAAQ==";
    for (const c of [v2, junk]) {
      const out = await runTaxEstimate(req, deps(chain([c, payment("2026-11-25T21:17:43Z", big)], WINDOW_START)));
      expect(out.status).toBe("unavailable");
    }
  });
});

describe("helpers", () => {
  it("lagosDate moves instants to the +01:00 calendar day", () => {
    expect(lagosDate("2026-12-31T22:59:59Z")).toBe("2026-12-31");
    expect(lagosDate("2026-12-31T23:00:00Z")).toBe("2027-01-01");
    expect(lagosDate("2025-12-31T23:00:00Z")).toBe("2026-01-01");
  });
  it("unitsToDecimal is exact", () => {
    expect(unitsToDecimal(BigInt(100000))).toBe("0.0100000");
    expect(unitsToDecimal(BigInt(1))).toBe("0.0000001");
    expect(unitsToDecimal(BigInt("12345678901234567890"))).toBe("1234567890123.4567890");
  });
});

describe("reading the request", () => {
  const ok = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" } };
  it("accepts the two income answers", () => {
    expect(parseTaxRequest(ok)).toEqual({ ok: true, req: { wallet: WALLET, annualRentNgn: undefined, otherIncome: { kind: "all-in-caracal" } } });
    expect(parseTaxRequest({ wallet: WALLET, annualRentNgn: " 500000 ", otherIncome: { kind: "elsewhere", amountNgn: "1", note: "x" } })).toMatchObject({ ok: true });
  });
  it("treats an empty rent box as no rent", () => {
    expect(parseTaxRequest({ ...ok, annualRentNgn: "  " })).toMatchObject({ ok: true, req: { annualRentNgn: undefined } });
  });
  it.each([
    ["not an object", 5],
    ["an array", []],
    ["a classic account as wallet", { ...ok, wallet: "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX" }],
    ["no wallet", { otherIncome: ok.otherIncome }],
    ["no income answer", { wallet: WALLET }],
    ["an unknown income answer", { wallet: WALLET, otherIncome: { kind: "maybe" } }],
    ["extra fields", { ...ok, extra: 1 }],
    ["extra income fields", { wallet: WALLET, otherIncome: { kind: "all-in-caracal", amountNgn: "5" } }],
    ["a non-text amount", { wallet: WALLET, otherIncome: { kind: "elsewhere", amountNgn: 5 } }],
    ["a non-text rent", { ...ok, annualRentNgn: 5 }],
    ["a long note", { wallet: WALLET, otherIncome: { kind: "elsewhere", amountNgn: "1", note: "x".repeat(201) } }],
  ])("refuses %s", (_n, body) => {
    expect(parseTaxRequest(body)).toMatchObject({ ok: false });
  });
});
