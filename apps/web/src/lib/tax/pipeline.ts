// From a wallet address to a tax estimate: read the wallet's payments from the
// chain, value each in naira at the CBN official rate for the day it arrived,
// and run the tax engine (packages/tax). Everything that can fail refuses; no
// step fills a gap with a guess. The only numbers in the output are the
// engine's, computed from chain payments and CBN rates that carry their source.

import { SPLIT, TOKENS } from "@/lib/stellar/config";
import { splitAddressFor } from "@/lib/stellar/split-address";
import { ChainReadError, isContractId, readSplitPayments, type ChainReader, type Coverage, type Payment } from "./chain-payments";
import { RateSourceError, quoteFor, type RateTable } from "./cbn-rates";
import { DISCLAIMER, estimate, getRules, type Account, type Estimate, type FxQuote, type LedgerEntry } from "@caracal/tax";

/** The tax year this page estimates: the only one the engine has rules for. */
export const TAX_YEAR = 2026;

export type TaxRequest = {
  /** The person's passkey wallet (C address). Its split contract is derived from it. */
  wallet: string;
  annualRentNgn?: string;
  /** Whether all income arrives in the split contract, or how much arrives elsewhere. */
  otherIncome: { kind: "all-in-caracal" } | { kind: "elsewhere"; amountNgn: string; note?: string };
};

const MAX_TEXT = 200;

/** Reads the request body. Anything unexpected is a plain message, never a guess. */
export function parseTaxRequest(body: unknown): { ok: true; req: TaxRequest } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "The request was not an object." };
  const b = body as Record<string, unknown>;
  const allowed = new Set(["wallet", "annualRentNgn", "otherIncome"]);
  if (Object.keys(b).some((k) => !allowed.has(k))) return { ok: false, message: "The request has fields Caracal does not know." };
  if (!isContractId(b.wallet)) return { ok: false, message: "The wallet must be a Stellar contract address (it starts with C)." };
  let annualRentNgn: string | undefined;
  if (b.annualRentNgn !== undefined) {
    if (typeof b.annualRentNgn !== "string" || b.annualRentNgn.length > MAX_TEXT) return { ok: false, message: "Annual rent must be text." };
    if (b.annualRentNgn.trim() !== "") annualRentNgn = b.annualRentNgn;
  }
  const o = b.otherIncome;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, message: "Say whether all your income arrives in your Caracal wallet." };
  const oi = o as Record<string, unknown>;
  if (oi.kind === "all-in-caracal") {
    if (Object.keys(oi).length !== 1) return { ok: false, message: "The income answer has fields Caracal does not know." };
    return { ok: true, req: { wallet: b.wallet, annualRentNgn, otherIncome: { kind: "all-in-caracal" } } };
  }
  if (oi.kind === "elsewhere") {
    if (Object.keys(oi).some((k) => !["kind", "amountNgn", "note"].includes(k))) return { ok: false, message: "The income answer has fields Caracal does not know." };
    if (typeof oi.amountNgn !== "string" || oi.amountNgn.length > MAX_TEXT) return { ok: false, message: "Say how much income arrives elsewhere, in naira." };
    if (oi.note !== undefined && (typeof oi.note !== "string" || oi.note.length > MAX_TEXT)) return { ok: false, message: "The note must be short text." };
    return { ok: true, req: { wallet: b.wallet, annualRentNgn, otherIncome: { kind: "elsewhere", amountNgn: oi.amountNgn, ...(oi.note ? { note: oi.note } : {}) } } };
  }
  return { ok: false, message: "Say whether all your income arrives in your Caracal wallet." };
}

export type TaxOutcome =
  | { status: "ok"; estimate: Estimate; context: Context }
  | { status: "refused"; reasons: string[]; disclaimer: string; context: Context | null }
  /** Nothing could be computed because a source could not be read. No numbers. */
  | { status: "unavailable"; message: string; disclaimer: string }
  /** The wallet has no split contract on this network, so there are no payments to estimate from. */
  | { status: "no-contract"; message: string; splitContract: string; disclaimer: string };

/** What the estimate was built from, shown with it. */
export type Context = {
  taxYear: number;
  splitContract: string;
  asOf: string;
  coverage: Coverage;
  /** Payments the contract recorded in the history window, and how many fall in the tax year (Nigeria time). */
  paymentsInWindow: number;
  paymentsInTaxYear: number;
};

export type PipelineDeps = {
  chain: ChainReader;
  /** Reads the CBN rate list; called only when a payment in the tax year needs a rate. */
  rateTable: () => Promise<RateTable>;
  now: () => Date;
};

const LAGOS_OFFSET_MS = 3_600_000;

/** The Nigerian (Lagos, +01:00) calendar date of an instant, YYYY-MM-DD. */
export function lagosDate(isoInstant: string): string {
  return new Date(Date.parse(isoInstant) + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** USDC smallest units as an exact decimal text with 7 decimals. */
export function unitsToDecimal(units: bigint): string {
  const scale = BigInt(10_000_000);
  return `${units / scale}.${(units % scale).toString().padStart(7, "0")}`;
}

const unavailable = (message: string): TaxOutcome => ({ status: "unavailable", message, disclaimer: DISCLAIMER });

export async function runTaxEstimate(req: TaxRequest, deps: PipelineDeps, networkPassphrase?: string): Promise<TaxOutcome> {
  if (getRules("NG", TAX_YEAR) === null) return unavailable(`Caracal has no tax rules for ${TAX_YEAR}.`);
  const splitContract = splitAddressFor(req.wallet, networkPassphrase);

  let read;
  try {
    read = await readSplitPayments(deps.chain, { contract: splitContract, owner: req.wallet, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash });
  } catch (e) {
    if (e instanceof ChainReadError) return unavailable(e.message);
    throw e;
  }
  if (read.kind === "no-contract") {
    return {
      status: "no-contract",
      splitContract,
      message: "Caracal found no split contract for this wallet on Stellar testnet (it may not be created yet, or it may have expired). There are no payments to estimate from.",
      disclaimer: DISCLAIMER,
    };
  }

  const inYear = (p: Payment) => lagosDate(p.occurredAt).startsWith(`${TAX_YEAR}-`);
  const yearPayments = read.payments.filter(inYear);

  // CBN rates, only for the days that have an in-year payment.
  const ownReasons: string[] = [];
  const quotes = new Map<string, FxQuote>();
  const days = [...new Set(yearPayments.map((p) => lagosDate(p.occurredAt)))].sort();
  if (days.length > 0) {
    let table: RateTable;
    try {
      table = await deps.rateTable();
    } catch (e) {
      if (e instanceof RateSourceError) return unavailable(`${e.message} Without the official CBN rate no payment can be valued in naira, so there is no estimate.`);
      throw e;
    }
    const retrievedAt = deps.now().toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const day of days) {
      const q = quoteFor(table, day, retrievedAt);
      if (q.ok) quotes.set(day, q.quote);
      else ownReasons.push(q.reason);
    }
  }

  const entries: LedgerEntry[] = read.payments.map((p) => ({
    id: p.eventId,
    accountId: splitContract,
    txHash: p.txHash,
    occurredAt: p.occurredAt,
    direction: "in",
    kind: "income",
    asset: "USDC",
    amount: unitsToDecimal(p.units),
    fx: { statutory: quotes.get(lagosDate(p.occurredAt)) ?? null, economic: null },
  }));
  const account: Account = {
    id: splitContract,
    label: "Your Caracal split contract (Stellar testnet)",
    lastSyncedAt: read.coverage.to,
    coverageFrom: read.coverage.from,
    // Only a creation event read from the chain, never anything inferred.
    ...(read.created ? { openedAt: read.created.occurredAt } : {}),
    gaps: [],
  };
  const asOf = deps.now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const context: Context = {
    taxYear: TAX_YEAR,
    splitContract,
    asOf,
    coverage: read.coverage,
    paymentsInWindow: read.payments.length,
    paymentsInTaxYear: yearPayments.length,
  };

  let result;
  try {
    result = estimate({
      country: "NG",
      taxYear: TAX_YEAR,
      asOf,
      entries,
      accounts: [account],
      profile: {
        ...(req.annualRentNgn !== undefined ? { annualRentNgn: req.annualRentNgn } : {}),
        incomeScope:
          req.otherIncome.kind === "all-in-caracal"
            ? { allIncomeInLinkedAccounts: true }
            : { allIncomeInLinkedAccounts: false, otherIncomeNgn: req.otherIncome.amountNgn, ...(req.otherIncome.note ? { otherIncomeNote: req.otherIncome.note } : {}) },
      },
    });
  } catch (e) {
    console.error("the tax engine threw:", e instanceof Error ? e.message : String(e));
    return unavailable("The tax engine failed unexpectedly, so there is no estimate.");
  }

  // Without a creation event in the window, the contract may be older than the window.
  // If the window also starts after the tax year does, say that plainly.
  if (result.status === "refused" && !read.created && Date.parse(read.coverage.from) > Date.parse(`${TAX_YEAR}-01-01T00:00:00+01:00`)) {
    ownReasons.unshift(
      `The split contract was created before the RPC's history window of about a week, so payments before ${read.coverage.from} cannot be read. A payment indexer is needed to read the whole of ${TAX_YEAR}.`,
    );
  }
  if (result.status === "refused") return { status: "refused", reasons: [...ownReasons, ...result.reasons.filter((r) => !ownReasons.includes(r))], disclaimer: result.disclaimer, context };
  // The engine accepted the input although a rate was missing: never show a number built on that.
  if (ownReasons.length > 0) return { status: "refused", reasons: ownReasons, disclaimer: DISCLAIMER, context };
  return { status: "ok", estimate: result, context };
}
