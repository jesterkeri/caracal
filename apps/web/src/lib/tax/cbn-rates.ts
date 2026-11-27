// The Central Bank of Nigeria's official naira rate, read from the CBN's own
// published data. Reflector has no NGN feed (docs/decisions.md, 2026-11-25), so
// this is the source.
//
// Source: the NFEM table on https://www.cbn.gov.ng/rates/ExchRateByCurrency.html.
// The page itself loads that table from https://www.cbn.gov.ng/api/GetAllNFEM_Rates
// (a JSON list, one row per business day, from 2024-12-02). The page says: "NFEM
// rate is derived at Volume Weighted Average and stands as the official exchange
// rate for the day". So the rate used is the row's `weightedAvgRate`, in naira per
// US dollar. CBN gives no documentation or terms for this endpoint, so it can
// change without notice; anything unexpected refuses instead of guessing.
//
// A day with no row (weekend, public holiday, not published yet) has no rate. The
// tax engine only accepts a rate dated the same day as the payment, so such a
// payment is refused, never valued with a neighbouring day's rate.

import type { FxQuote } from "./engine";

export const CBN_NFEM_DATA_URL = "https://www.cbn.gov.ng/api/GetAllNFEM_Rates";
/** The page a person can open to see the same table. It is the quote's sourceUrl. */
export const CBN_RATES_PAGE_URL = "https://www.cbn.gov.ng/rates/ExchRateByCurrency.html";
export const CBN_PROVIDER = "CBN";

const MAX_BODY_CHARS = 5_000_000;
const FETCH_TIMEOUT_MS = 20_000;

/** The rate source could not be read, or answered with something that cannot be trusted. */
export class RateSourceError extends Error {}

export type RateTable = {
  /** YYYY-MM-DD to the NFEM weighted average rate (naira per US dollar, exactly as CBN wrote it). */
  byDate: Map<string, string>;
  /** Dates with no single readable rate: listed twice with different rates, or with an unreadable rate. */
  conflicting: Set<string>;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "November-26-2026" to "2026-11-26", or null when it is not a real date in that form. */
function parseCbnDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = /^([A-Za-z]+)-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!) + 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2]}`;
}

/** A positive plain decimal with at most 6 decimal places (the tax engine's limit). */
const RATE_FORMAT = /^(?!0+(\.0+)?$)\d{1,9}(\.\d{1,6})?$/;

/**
 * Reads CBN's NFEM list. Refuses the whole list when it is not a list of rows
 * with a readable date: a change of format must not turn into rates. A row
 * whose rate cannot be read leaves just that day without a rate.
 */
export function parseNfemTable(json: unknown): RateTable {
  if (!Array.isArray(json) || json.length === 0) throw new RateSourceError("The CBN rate list was not a list of rates.");
  const byDate = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const row of json as unknown[]) {
    if (typeof row !== "object" || row === null) throw new RateSourceError("The CBN rate list has a row that is not an object.");
    const { ratedate, weightedAvgRate } = row as Record<string, unknown>;
    const date = parseCbnDate(ratedate);
    if (date === null) throw new RateSourceError("The CBN rate list has a row with a date Caracal cannot read.");
    if (typeof weightedAvgRate !== "string" || !RATE_FORMAT.test(weightedAvgRate)) {
      conflicting.add(date);
      continue;
    }
    const seen = byDate.get(date);
    if (seen !== undefined && seen !== weightedAvgRate) conflicting.add(date);
    else byDate.set(date, weightedAvgRate);
  }
  return { byDate, conflicting };
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** Downloads and reads the CBN list. Throws RateSourceError when that cannot be done. */
export async function fetchNfemTable(fetchFn: FetchLike = fetch as FetchLike): Promise<RateTable> {
  let text: string;
  try {
    const res = await fetchFn(CBN_NFEM_DATA_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) throw new RateSourceError(`The CBN rate list answered with status ${res.status}.`);
    if (!(res.headers.get("content-type") ?? "").includes("json")) throw new RateSourceError("The CBN rate list did not answer with JSON.");
    text = await res.text();
  } catch (e) {
    if (e instanceof RateSourceError) throw e;
    throw new RateSourceError("Caracal could not reach the CBN rate list.");
  }
  if (text.length > MAX_BODY_CHARS) throw new RateSourceError("The CBN rate list was larger than expected.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RateSourceError("The CBN rate list could not be read.");
  }
  return parseNfemTable(json);
}

export type QuoteResult = { ok: true; quote: FxQuote } | { ok: false; reason: string };

/** The structured CBN USD/NGN quote for one Lagos calendar day, or why there is none. */
export function quoteFor(table: RateTable, date: string, retrievedAt: string): QuoteResult {
  if (table.conflicting.has(date)) return { ok: false, reason: `The CBN list has no single readable official rate for ${date}.` };
  const rate = table.byDate.get(date);
  if (rate === undefined) {
    return { ok: false, reason: `The CBN has published no official rate for ${date} (a weekend or public holiday, or not published yet), so a payment on that day cannot be valued.` };
  }
  return { ok: true, quote: { provider: CBN_PROVIDER, base: "USD", quote: "NGN", date, ngnPerUnit: rate, sourceUrl: CBN_RATES_PAGE_URL, retrievedAt } };
}
