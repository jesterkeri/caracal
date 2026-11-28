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
  /**
   * The person's own answer for each in-year payment from someone other than their own wallet, by payment
   * (event) id. An on-chain payment proves an amount and a sender, not what it was for, so Caracal never
   * decides that: a payment without an answer means no estimate.
   */
  classifications?: Record<string, Classification>;
};

export type Classification = "income" | "not_income";

const MAX_TEXT = 200;
/** As many answers as there are payments Caracal will check (MAX_PAYMENTS). */
const MAX_ANSWERS = 100;
const MAX_ID = 64;

/** Reads the request body. Anything unexpected is a plain message, never a guess. */
export function parseTaxRequest(body: unknown): { ok: true; req: TaxRequest } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "The request was not an object." };
  const b = body as Record<string, unknown>;
  const allowed = new Set(["wallet", "annualRentNgn", "otherIncome", "classifications"]);
  if (Object.keys(b).some((k) => !allowed.has(k))) return { ok: false, message: "The request has fields Caracal does not know." };
  if (!isContractId(b.wallet)) return { ok: false, message: "The wallet must be a Stellar contract address (it starts with C)." };
  let annualRentNgn: string | undefined;
  if (b.annualRentNgn !== undefined) {
    if (typeof b.annualRentNgn !== "string" || b.annualRentNgn.length > MAX_TEXT) return { ok: false, message: "Annual rent must be text." };
    if (b.annualRentNgn.trim() !== "") annualRentNgn = b.annualRentNgn;
  }
  let classifications: Record<string, Classification> | undefined;
  if (b.classifications !== undefined) {
    const c = b.classifications;
    if (typeof c !== "object" || c === null || Array.isArray(c)) return { ok: false, message: "The payment answers must be a list of payment and answer pairs." };
    const keys = Object.keys(c);
    if (keys.length > MAX_ANSWERS) return { ok: false, message: "There are more payment answers than Caracal can check." };
    classifications = {};
    for (const k of keys) {
      const v = (c as Record<string, unknown>)[k];
      if (k.length === 0 || k.length > MAX_ID) return { ok: false, message: "A payment answer names a payment Caracal does not know." };
      if (v !== "income" && v !== "not_income") return { ok: false, message: "Each payment answer must be income or not income." };
      Object.defineProperty(classifications, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
  }
  const withAnswers = (r: Omit<TaxRequest, "classifications">): TaxRequest => (classifications === undefined ? r : { ...r, classifications });
  const o = b.otherIncome;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, message: "Say whether all your income arrives in your Caracal wallet." };
  const oi = o as Record<string, unknown>;
  if (oi.kind === "all-in-caracal") {
    if (Object.keys(oi).length !== 1) return { ok: false, message: "The income answer has fields Caracal does not know." };
    return { ok: true, req: withAnswers({ wallet: b.wallet, annualRentNgn, otherIncome: { kind: "all-in-caracal" } }) };
  }
  if (oi.kind === "elsewhere") {
    if (Object.keys(oi).some((k) => !["kind", "amountNgn", "note"].includes(k))) return { ok: false, message: "The income answer has fields Caracal does not know." };
    if (typeof oi.amountNgn !== "string" || oi.amountNgn.length > MAX_TEXT) return { ok: false, message: "Say how much income arrives elsewhere, in naira." };
    if (oi.note !== undefined && (typeof oi.note !== "string" || oi.note.length > MAX_TEXT)) return { ok: false, message: "The note must be short text." };
    return { ok: true, req: withAnswers({ wallet: b.wallet, annualRentNgn, otherIncome: { kind: "elsewhere", amountNgn: oi.amountNgn, ...(oi.note ? { note: oi.note } : {}) } }) };
  }
  return { ok: false, message: "Say whether all your income arrives in your Caracal wallet." };
}

export type TaxOutcome =
  | { status: "ok"; estimate: Estimate; context: Context }
  | { status: "refused"; reasons: string[]; disclaimer: string; context: Context | null; /** Set when the refusal is about the person's payment answers: every in-year payment to answer for. */ payments?: PaymentRow[]; /** The payments are listed for information only: no answer can lead to an estimate (adversary t21). */ listOnly?: true }
  /** Nothing could be computed because a source could not be read. No numbers. */
  | { status: "unavailable"; message: string; disclaimer: string }
  /** The wallet has no split contract on this network, so there are no payments to estimate from. */
  | { status: "no-contract"; message: string; splitContract: string; disclaimer: string };

/** One in-year payment, as the person sees it when they say whether it was income. */
export type PaymentRow = {
  id: string;
  /** The Nigeria (Lagos) date of the payment. */
  date: string;
  occurredAt: string;
  /** USDC, exact decimal text. */
  amount: string;
  asset: "USDC";
  from: string;
  invoiceRef: string;
};

/** What the estimate was built from, shown with it. */
export type Context = {
  taxYear: number;
  splitContract: string;
  /** When the estimate was computed. What it covers is `coverage`: payments recorded through its ledger, and none after. */
  asOf: string;
  coverage: Coverage;
  /** Payments the person answered "not income" for: left out by their own answer, not checked on chain. */
  excludedByAnswer: PaymentRow[];
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

/** A payment the owner made from their own wallet into their own split contract is not income. */
const isOwnPayment = (p: Payment, owner: string) => p.from === owner;

const rowOf = (p: Payment): PaymentRow => ({ id: p.eventId, date: lagosDate(p.occurredAt), occurredAt: p.occurredAt, amount: unitsToDecimal(p.units), asset: "USDC", from: p.from, invoiceRef: p.invoiceRef });

const unavailable = (message: string): TaxOutcome => ({ status: "unavailable", message, disclaimer: DISCLAIMER });

export async function runTaxEstimate(req: TaxRequest, deps: PipelineDeps, networkPassphrase?: string): Promise<TaxOutcome> {
  if (getRules("NG", TAX_YEAR) === null) return unavailable(`Caracal has no tax rules for ${TAX_YEAR}.`);
  // Naira typed by the person must be digits, with any kobo after a point. Any other form is refused at once, saying
  // what to change, before the network is read or a payment is asked about (adversary t22): the engine's own reason
  // ("at most 2 decimal places") is false for "600,000" or "N600000".
  const typed = [
    ...(req.annualRentNgn !== undefined ? [{ value: req.annualRentNgn, what: "The rent you pay for the year", example: "600000" }] : []),
    ...(req.otherIncome.kind === "elsewhere" ? [{ value: req.otherIncome.amountNgn, what: "The income that arrives elsewhere", example: "2500000" }] : []),
  ];
  const typedReasons = typed
    .filter((t) => !/^\d+(\.\d+)?$/.test(t.value.trim()))
    .map((t) =>
      t.value.trim() === ""
        ? `${t.what} is missing. Write it in naira, in digits, for example ${t.example}. No estimate was made.`
        : `${t.what} must be written in digits only, with no commas, spaces, letters or ₦ sign, for example ${t.example} (kobo go after a point, as in ${t.example}.50). No estimate was made.`,
    );
  if (typedReasons.length > 0) return { status: "refused", reasons: typedReasons, disclaimer: DISCLAIMER, context: null };
  const splitContract = splitAddressFor(req.wallet, networkPassphrase);

  let read;
  try {
    read = await readSplitPayments(deps.chain, { contract: splitContract, owner: req.wallet, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash, earlierWasmHashes: SPLIT.earlierWasmHashes });
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

  // Without a creation event in the window, say only what is known. A split on Caracal's earlier wasm (which records
  // no creation) was refused before this point (chain-payments.ts), so this one runs the current wasm, whose
  // constructor always records it: it was created before the window. If the window also starts after the tax year
  // does, no answer can lead to an estimate, so this is said first, before any payment is asked about (adversary t21).
  const creationReason =
    !read.created && Date.parse(read.coverage.from) > Date.parse(`${TAX_YEAR}-01-01T00:00:00+01:00`)
      ? `No record of the split contract's creation was found in the RPC's history window of about a week, so the contract was created before that window. Payments before ${read.coverage.from} cannot be read. A payment indexer is needed to read the whole of ${TAX_YEAR}.`
      : null;
  if (creationReason) {
    const asOfNow = deps.now().toISOString().replace(/\.\d{3}Z$/, "Z");
    return {
      status: "refused",
      reasons: [creationReason],
      disclaimer: DISCLAIMER,
      // What was found is shown, but no answer is asked for: none could lead to an estimate.
      payments: yearPayments.filter((p) => !isOwnPayment(p, req.wallet)).map(rowOf),
      listOnly: true,
      context: { taxYear: TAX_YEAR, splitContract, asOf: asOfNow, coverage: read.coverage, excludedByAnswer: [], paymentsInWindow: read.payments.length, paymentsInTaxYear: yearPayments.length },
    };
  }

  // Whether a payment is income is the person's answer, never a guess from its sender: an on-chain payment
  // proves an amount and a sender, not what it was for (it may be a refund, or a transfer from another
  // wallet of their own). Every in-year payment that is not from the owner's wallet needs an answer first.
  const answers = req.classifications ?? {};
  const has = (id: string) => Object.prototype.hasOwnProperty.call(answers, id);
  const answerable = yearPayments.filter((p) => !isOwnPayment(p, req.wallet));
  const known = new Set(answerable.map((p) => p.eventId));
  const unknownAnswers = Object.keys(answers).filter((id) => !known.has(id));
  const unanswered = answerable.filter((p) => !has(p.eventId));
  if (unknownAnswers.length > 0 || unanswered.length > 0) {
    const reasons: string[] = [];
    if (unanswered.length > 0) {
      reasons.push(
        `${unanswered.length} of your ${TAX_YEAR} payments ${unanswered.length === 1 ? "has" : "have"} not been marked as income or not income. A payment on chain shows an amount and who sent it, not what it was for (it could be a refund, or a transfer from another wallet of yours), so Caracal will not guess. Answer for each payment and estimate again.`,
      );
    }
    if (unknownAnswers.length > 0) {
      reasons.push(`${unknownAnswers.length} of the answers sent name a payment that is not one of your ${TAX_YEAR} payments into this split contract (the list may have changed). Answer again from the list below.`);
    }
    return { status: "refused", reasons, disclaimer: DISCLAIMER, context: null, payments: answerable.map(rowOf) };
  }
  const notIncome = new Set(answerable.filter((p) => answers[p.eventId] === "not_income").map((p) => p.eventId));

  // CBN rates, only for the days that have an in-year income payment. The owner's own transfers and the
  // payments the person says are not income are never valued, so a day with only those needs no rate.
  const ownReasons: string[] = [];
  const quotes = new Map<string, FxQuote>();
  const days = [...new Set(answerable.filter((p) => !notIncome.has(p.eventId)).map((p) => lagosDate(p.occurredAt)))].sort();
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

  // Payments answered "not income" are not given to the engine: they are listed in the result as left out by the person's answer.
  const entries: LedgerEntry[] = read.payments.filter((p) => !notIncome.has(p.eventId)).map((p) => ({
    id: p.eventId,
    accountId: splitContract,
    txHash: p.txHash,
    occurredAt: p.occurredAt,
    direction: "in",
    kind: isOwnPayment(p, req.wallet) ? "own_transfer" : "income",
    asset: "USDC",
    amount: unitsToDecimal(p.units),
    // The invoice id the split event carries: the contract takes one deposit per invoice.
    paymentRef: p.invoiceRef,
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
    excludedByAnswer: answerable.filter((p) => notIncome.has(p.eventId)).map(rowOf),
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
      // The account's sync time is the stable ledger's close time (read.coverage.to); the estimate may not be much later.
      staleAfterHours: 1,
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

  // The engine speaks of a linked account to sync. Here the "account" is the split contract read from the network, and
  // its sync time is the close time of the newest ledger the RPC returned: an old one is the network's or the RPC's
  // lag, which the person cannot sync (adversary t20).
  const synced = `Account "${account.label}" was last synced at ${account.lastSyncedAt}, `;
  // A server clock behind the newest ledger's close time (adversary t22): the engine says the account "says it was
  // synced" after the estimate's time, which is this server's clock.
  const ahead = `Account "${account.label}" says it was synced at ${account.lastSyncedAt}, which is after `;
  const head = `The newest ledger Caracal could read from the Stellar network closed at ${account.lastSyncedAt}`;
  const plain = (r: string) =>
    r.startsWith(ahead)
      ? `${head}, which is later than this server's clock (${asOf}). The server's clock is behind the network's, so no estimate was made. Try again in a minute; if this keeps happening, the server's clock needs setting right.`
      : !r.startsWith(synced)
      ? r
      : r.includes("which is too old")
        ? `${head}, more than an hour ago, so the payment history Caracal read may be behind (the testnet may be halted, or its RPC lagging). No estimate was made. Try again later.`
        : r.includes(`before ${TAX_YEAR} ended`)
          ? `${head}, before ${TAX_YEAR} ended, so payments from the end of the year may be missing (the testnet may be halted, or its RPC lagging). No estimate was made. Try again later.`
          : r;
  if (result.status === "refused") {
    const engine = result.reasons.map(plain);
    return { status: "refused", reasons: [...ownReasons, ...engine.filter((r) => !ownReasons.includes(r))], disclaimer: result.disclaimer, context };
  }
  // The engine accepted the input although a rate was missing: never show a number built on that.
  if (ownReasons.length > 0) return { status: "refused", reasons: ownReasons, disclaimer: DISCLAIMER, context };
  return { status: "ok", estimate: result, context };
}
