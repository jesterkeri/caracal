import {
  type Dec,
  formatKobo,
  formatRatio,
  koboTimesRate,
  mulToKobo,
  parseDec,
  toKobo,
} from "./decimal";
import { getRules } from "./rules";
import type {
  BandResult,
  EstimateInput,
  EstimateResult,
  DeclaredIncomeLine,
  Informational,
  IncomeLine,
  LedgerEntry,
  Rules,
  SourceRef,
} from "./types";

export const DISCLAIMER = "This is an estimate, not tax advice.";
const DEFAULT_STALE_HOURS = 24;
const MAX_AMOUNT_DP = 7;
/** Most decimal places an exchange rate (statutory or economic) may carry. */
const MAX_RATE_DP = 6;
/** Most decimal places a naira amount typed by a person may carry (kobo). */
const MAX_NAIRA_INPUT_DP = 2;
const DIRECTIONS: readonly string[] = ["in", "out"];
const KINDS: readonly string[] = ["income", "own_transfer", "cashout", "split_internal", "refund", "other"];

const toSource = (r: { id: string; citation: string; url: string; confidence: SourceRef["confidence"] }): SourceRef => ({
  ruleId: r.id,
  citation: r.citation,
  url: r.url,
  confidence: r.confidence,
});

function refuse(reasons: string[]): EstimateResult {
  return { status: "refused", reasons, disclaimer: DISCLAIMER };
}

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function validYmd(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * Parses an instant that must carry Z or a numeric offset, checking every
 * component by hand. NaN when any part is impossible. Never uses Date.parse,
 * which rolls 30 February over to 2 March.
 */
function ms(iso: string): number {
  if (typeof iso !== "string") return Number.NaN;
  const m = INSTANT_RE.exec(iso);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || sec > 59) return Number.NaN;
  const milli = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  let offsetMin = 0;
  if (m[8] !== "Z") {
    const sign = m[8]!.startsWith("-") ? -1 : 1;
    const oh = Number(m[8]!.slice(1, 3));
    const om = Number(m[8]!.slice(4, 6));
    if (om > 59 || oh > 14 || (oh === 14 && om > 0)) return Number.NaN;
    offsetMin = sign * (oh * 60 + om);
  }
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, sec, milli);
  return dt.getTime() - offsetMin * 60_000;
}

/** True only for a real calendar date written YYYY-MM-DD. */
function validDate(d: unknown): d is string {
  if (typeof d !== "string") return false;
  const m = DATE_RE.exec(d);
  return !!m && validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

const nonEmpty = (s: unknown): boolean => typeof s === "string" && s.trim() !== "";

/** Local calendar date (YYYY-MM-DD) of an instant, in the rules' timezone. */
function localDate(instantMs: number, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h = "0", m = "0"] = offset.slice(1).split(":");
  const shift = sign * (Number(h) * 60 + Number(m)) * 60_000;
  return new Date(instantMs + shift).toISOString().slice(0, 10);
}

type Quote = LedgerEntry["fx"]["statutory"] & object;

/** Fields every quote needs, statutory or economic. Returns a reason or null. */
function checkQuoteShape(e: LedgerEntry, q: Quote, label: string, asOfMs: number, assetBase: string | undefined, offset: string): string | null {
  const who = `Entry ${e.id}: the ${label}`;
  if (q === null || typeof q !== "object") return `${who} is malformed.`;
  if (!nonEmpty(q.provider)) return `${who} has no provider.`;
  if (q.quote !== "NGN") return `${who} must be quoted in NGN, got "${String(q.quote)}".`;
  if (!nonEmpty(q.base) || q.base !== assetBase) {
    return `${who} is for the pair ${String(q.base)}/${String(q.quote)}, but ${e.asset} must be valued with a ${String(assetBase)}/NGN rate.`;
  }
  if (!nonEmpty(q.sourceUrl)) return `${who} has no sourceUrl.`;
  if (!validDate(q.date)) return `${who} date is not a valid YYYY-MM-DD date.`;
  const got = ms(q.retrievedAt);
  if (Number.isNaN(got)) return `${who}: retrievedAt is not a valid date with a Z or +HH:MM offset.`;
  if (got > asOfMs) return `${who}: retrievedAt (${q.retrievedAt}) is after ${String(asOfMsLabel(asOfMs))}. That cannot be right.`;
  if (got < ms(`${q.date}T00:00:00${offset}`)) {
    return `${who}: retrievedAt (${q.retrievedAt}) is before the start of the quote date ${q.date}. A rate cannot be fetched before its day begins.`;
  }
  try {
    if (parseDec(q.ngnPerUnit).scale > MAX_RATE_DP) {
      return `${who} rate has more than ${MAX_RATE_DP} decimal places, which no real rate source gives.`;
    }
  } catch {
    // An unparseable rate is reported by the caller.
  }
  return null;
}

const asOfMsLabel = (t: number): string => new Date(t).toISOString();

function baseFor(rules: Rules, asset: string): string | undefined {
  const map = rules.valuation.assetBase;
  return typeof asset === "string" && Object.prototype.hasOwnProperty.call(map, asset) ? map[asset] : undefined;
}

function checkStatutory(e: LedgerEntry, q: Quote, rules: Rules, asOfMs: number): string | null {
  const base = baseFor(rules, e.asset);
  if (base === undefined) {
    return `Entry ${e.id}: ${String(e.asset)} cannot be valued yet. Only ${Object.keys(rules.valuation.assetBase).join(", ")} can be valued today.`;
  }
  const bad = checkQuoteShape(e, q, "official naira rate", asOfMs, base, rules.timezoneOffset);
  if (bad) return bad;
  const prov = rules.valuation.statutoryProviders.find((p) => p.id === q.provider);
  if (!prov) return `Entry ${e.id}: the official naira rate comes from provider "${q.provider}", which is not an accepted official source.`;
  if (!q.sourceUrl.startsWith(prov.urlPrefix)) {
    return `Entry ${e.id}: the official naira rate sourceUrl must start with ${prov.urlPrefix} for provider ${prov.id}.`;
  }
  return null;
}

function checkEconomic(e: LedgerEntry, q: Quote, rules: Rules, asOfMs: number): string | null {
  const bad = checkQuoteShape(e, q, "market rate", asOfMs, baseFor(rules, e.asset), rules.timezoneOffset);
  if (bad) return bad;
  if (!/^https:\/\/\S+$/.test(q.sourceUrl)) return `Entry ${e.id}: the market rate sourceUrl must be an https URL.`;
  try {
    if (parseDec(q.ngnPerUnit).n === 0n) return `Entry ${e.id}: the market rate is zero.`;
  } catch {
    return `Entry ${e.id}: the market rate is not a valid number.`;
  }
  return null;
}

/**
 * Naira the user typed into a form may carry stray spaces, so those are
 * trimmed. Ledger amounts and rates come from data and are parsed strictly.
 */
function parseTypedNaira(v: unknown) {
  if (typeof v !== "string") throw new RangeError("not a string");
  return parseDec(v.trim());
}

/** An amount with trailing fractional zeros removed, or the raw value if it does not parse. */
function canonicalAmount(v: unknown): unknown {
  try {
    const t = parseDec(v as string);
    let n = t.n;
    let scale = t.scale;
    while (scale > 0 && n % 10n === 0n) {
      n /= 10n;
      scale -= 1;
    }
    return `${n}e-${scale}`;
  } catch {
    return v;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * JSON can only make string conversion throw through an object that has its
 * own toString or valueOf field (e.g. {"toString": 1}). Reasons interpolate
 * input values, so refuse such objects anywhere in the input before reading it.
 */
function convertibleKeyPath(v: unknown, path: string, seen: Set<object>): string | null {
  if (typeof v !== "object" || v === null || seen.has(v)) return null;
  seen.add(v);
  if (!Array.isArray(v) && (Object.hasOwn(v, "toString") || Object.hasOwn(v, "valueOf"))) return path;
  for (const [k, child] of Object.entries(v)) {
    const found = convertibleKeyPath(child, Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`, seen);
    if (found) return found;
  }
  return null;
}

/**
 * The structure every later check relies on, so malformed JSON is refused with
 * a reason instead of throwing. Values are checked later.
 */
function shapeReasons(input: unknown): string[] {
  if (!isObject(input)) return ["The estimate input must be an object."];
  const hostile = convertibleKeyPath(input, "input", new Set());
  if (hostile) return [`${hostile} has a "toString" or "valueOf" field, which is not part of the documented structure.`];
  const reasons: string[] = [];
  if (!Array.isArray(input.accounts)) reasons.push("accounts must be a list.");
  else {
    const ids = new Set<string>();
    input.accounts.forEach((a: unknown, i: number) => {
      if (!isObject(a)) {
        reasons.push(`Account ${i + 1} must be an object.`);
        return;
      }
      // Entries are matched to accounts by id, so ids must exist and be unique.
      if (typeof a.id !== "string" || a.id.trim() === "") reasons.push(`Account ${i + 1} has no id.`);
      else if (ids.has(a.id)) reasons.push(`Account id "${a.id}" appears more than once.`);
      else ids.add(a.id);
      if (!Array.isArray(a.gaps)) reasons.push(`Account ${i + 1}: gaps must be a list (empty if there are none).`);
      else if (!a.gaps.every(isObject)) reasons.push(`Account ${i + 1}: every gap must be an object with from and to.`);
    });
  }
  if (!Array.isArray(input.entries)) reasons.push("entries must be a list.");
  else
    input.entries.forEach((e: unknown, i: number) => {
      if (!isObject(e)) reasons.push(`Entry ${i + 1} must be an object.`);
      // Duplicates are found by id, so it must be a non-empty string: 1 and "1"
      // would otherwise count the same payment twice.
      else if (typeof e.id !== "string" || e.id.trim() === "") reasons.push(`Entry ${i + 1} has no id (a non-empty string).`);
      else if (typeof e.txHash !== "string" || e.txHash.trim() === "") reasons.push(`Entry ${e.id} has no txHash (a non-empty string).`);
      else if (!isObject(e.fx)) reasons.push(`Entry ${String(e.id)}: fx must be an object with statutory and economic quotes.`);
    });
  if (!isObject(input.profile)) reasons.push("profile must be an object.");
  return reasons;
}

/**
 * `rulesOverride` exists so tests can exercise a rules file the registry does
 * not hold. Production callers leave it out.
 */
export function estimate(input: EstimateInput, rulesOverride?: Rules): EstimateResult {
  // Malformed JSON must be refused, never thrown. The checks below are meant to
  // catch it first; this is the backstop for anything they miss.
  try {
    return estimateChecked(input, rulesOverride);
  } catch (err) {
    return refuse([`The input could not be read (${err instanceof Error ? err.name : "error"}). Check that it matches the documented structure.`]);
  }
}

function estimateChecked(input: EstimateInput, rulesOverride?: Rules): EstimateResult {
  // Inputs often arrive as JSON from an untyped boundary: "2026" as a string
  // would still find the rules but break the period arithmetic, so check types.
  const shape = shapeReasons(input);
  if (shape.length > 0) return refuse(shape);
  if (typeof input.taxYear !== "number" || !Number.isInteger(input.taxYear)) {
    return refuse([`taxYear must be a whole number, got ${JSON.stringify(input.taxYear)}.`]);
  }
  if (typeof input.country !== "string") {
    return refuse([`country must be a string, got ${JSON.stringify(input.country)}.`]);
  }
  const rules = rulesOverride ?? getRules(input.country, input.taxYear);
  if (!rules) {
    return refuse([`No tax rules for ${input.country} ${input.taxYear}.`]);
  }

  const reasons: string[] = [];
  const asOfMs = ms(input.asOf);
  if (Number.isNaN(asOfMs)) {
    return refuse([`asOf is not a valid date with a Z or +HH:MM offset: ${String(input.asOf)}`]);
  }
  if (rules.valuation.rateDateRule !== "same_day") {
    return refuse([`Unsupported rate date rule "${String(rules.valuation.rateDateRule)}" in the ${rules.country} ${rules.year} rules.`]);
  }

  const periodStart = ms(`${input.taxYear}-01-01T00:00:00${rules.timezoneOffset}`);
  const periodEnd = ms(`${input.taxYear + 1}-01-01T00:00:00${rules.timezoneOffset}`);
  if (asOfMs < periodStart) {
    return refuse([`asOf (${input.asOf}) is before ${input.taxYear} begins, so the tax year has not started.`]);
  }
  const staleHours = input.staleAfterHours ?? DEFAULT_STALE_HOURS;
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    return refuse([`staleAfterHours must be a positive number of hours, got ${String(input.staleAfterHours)}.`]);
  }
  const staleMs = staleHours * 3_600_000;

  // Accounts: there must be at least one, and each must be fresh and gap free.
  if (input.accounts.length === 0) {
    reasons.push("No linked accounts, so Caracal cannot tell whether your history is complete.");
  }
  for (const a of input.accounts) {
    const synced = ms(a.lastSyncedAt);
    if (Number.isNaN(synced)) {
      reasons.push(`Account "${a.label}": lastSyncedAt is not a valid date with a Z or +HH:MM offset.`);
    } else if (synced > asOfMs) {
      reasons.push(`Account "${a.label}" says it was synced at ${a.lastSyncedAt}, which is after ${input.asOf}. That cannot be right.`);
    } else if (asOfMs - synced > staleMs) {
      reasons.push(`Account "${a.label}" was last synced at ${a.lastSyncedAt}, which is too old. Sync it again.`);
    }
    if (!Number.isNaN(synced) && asOfMs >= periodEnd && synced < periodEnd) {
      reasons.push(`Account "${a.label}" was last synced at ${a.lastSyncedAt}, before ${input.taxYear} ended, so income from the end of the year may be missing. Sync it again.`);
    }
    const cov = ms(a.coverageFrom);
    if (!Number.isNaN(synced) && !Number.isNaN(cov) && synced < cov) {
      reasons.push(`Account "${a.label}": lastSyncedAt (${a.lastSyncedAt}) is before coverageFrom (${a.coverageFrom}). That cannot be right.`);
    }
    if (!Number.isNaN(cov) && cov > asOfMs) {
      reasons.push(`Account "${a.label}": coverageFrom (${a.coverageFrom}) is after ${input.asOf}. That cannot be right.`);
    }
    let required = periodStart;
    let openedOk = true;
    if (a.openedAt !== undefined) {
      const opened = ms(a.openedAt);
      if (Number.isNaN(opened)) {
        openedOk = false;
        reasons.push(`Account "${a.label}": openedAt is not a valid date with a Z or +HH:MM offset.`);
      } else {
        if (opened > asOfMs) {
          openedOk = false;
          reasons.push(`Account "${a.label}": openedAt (${a.openedAt}) is after ${input.asOf}. That cannot be right.`);
        }
        if (!Number.isNaN(synced) && synced < opened) {
          openedOk = false;
          reasons.push(`Account "${a.label}": lastSyncedAt (${a.lastSyncedAt}) is before openedAt (${a.openedAt}). That cannot be right.`);
        }
        if (opened > required) required = opened;
      }
    }
    if (Number.isNaN(cov)) {
      reasons.push(`Account "${a.label}": coverageFrom is not a valid date with a Z or +HH:MM offset.`);
    } else if (openedOk && cov > required) {
      reasons.push(`Account "${a.label}" only has complete history from ${a.coverageFrom}, which is after ${new Date(required).toISOString()}. Income before that date may be missing.`);
    }
    for (const g of a.gaps) {
      const from = ms(g.from);
      const to = ms(g.to);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        if (Number.isNaN(from)) reasons.push(`Account "${a.label}": gap from is not a valid date with a Z or +HH:MM offset.`);
        if (Number.isNaN(to)) reasons.push(`Account "${a.label}": gap to is not a valid date with a Z or +HH:MM offset.`);
      } else if (from > to) {
        reasons.push(`Account "${a.label}" has a gap that ends before it starts (${g.from} to ${g.to}).`);
      } else if (from < to && from < periodEnd && to > periodStart) {
        // A gap is [from, to): `to` is the instant history resumes, the same
        // meaning as coverageFrom. The year is [start, end). So a gap that only
        // touches the year at one end does not overlap it.
        reasons.push(`Account "${a.label}" has missing history from ${g.from} to ${g.to}, inside ${input.taxYear}.`);
      }
    }
  }

  // Income entries.
  type Parsed = { e: (typeof input.entries)[number]; amt: Dec; rate: Dec };
  const parsed: Parsed[] = [];
  const seenIds = new Set<string>();
  const accountIds = new Set(input.accounts.map((a) => a.id));
  const syncedById = new Map<string, { label: string; raw: string; ms: number }>();
  for (const a of input.accounts) syncedById.set(a.id, { label: a.label, raw: a.lastSyncedAt, ms: ms(a.lastSyncedAt) });
  const openedAtById = new Map<string, { label: string; raw: string; ms: number }>();
  for (const a of input.accounts) {
    if (a.openedAt !== undefined) openedAtById.set(a.id, { label: a.label, raw: a.openedAt, ms: ms(a.openedAt) });
  }
  // Every entry's kind and direction must be a known value, checked before any
  // filtering so an unknown value can never silently drop an entry.
  for (const e of input.entries) {
    if (!KINDS.includes(e.kind)) reasons.push(`Entry ${String(e.id)} has an unknown kind "${String(e.kind)}".`);
    if (!DIRECTIONS.includes(e.direction)) reasons.push(`Entry ${String(e.id)} has an unknown direction "${String(e.direction)}".`);
  }
  // The same on-chain payment listed under two entry ids would be counted
  // twice. One transaction paying the same account the same amount of the same
  // asset twice is rare, and refusing it is the safe failure.
  const paymentKeys = new Map<string, string>();
  for (const e of input.entries) {
    if (e.kind !== "income") continue;
    // Compare the amount as a number (10000 = 10000.0) and the hash ignoring
    // hex case, so formatting cannot hide a duplicate.
    const k = JSON.stringify([e.accountId, String(e.txHash).trim().toLowerCase().replace(/^0x/, ""), e.asset, canonicalAmount(e.amount)]);
    const first = paymentKeys.get(k);
    if (first !== undefined) {
      reasons.push(`Entries ${first} and ${e.id} have the same transaction (${e.txHash}), account, asset and amount, so they look like the same payment listed twice.`);
    } else paymentKeys.set(k, e.id);
  }
  for (const e of input.entries) {
    if (!KINDS.includes(e.kind) || !DIRECTIONS.includes(e.direction)) continue;
    if (seenIds.has(e.id)) {
      reasons.push(`Entry ${e.id} appears more than once in the ledger.`);
      continue;
    }
    seenIds.add(e.id);
    if (!accountIds.has(e.accountId)) {
      reasons.push(`Entry ${e.id} belongs to account "${String(e.accountId)}", which is not one of your linked accounts.`);
      continue;
    }
    const occurred = ms(e.occurredAt);
    if (Number.isNaN(occurred)) {
      reasons.push(`Entry ${e.id}: occurredAt is not a valid date with a Z or +HH:MM offset.`);
      continue;
    }
    const opened = openedAtById.get(e.accountId);
    if (opened && !Number.isNaN(opened.ms) && occurred < opened.ms) {
      reasons.push(`Entry ${e.id} is dated ${e.occurredAt}, before account "${opened.label}" was opened (${opened.raw}). That cannot be right.`);
      continue;
    }
    const sync = syncedById.get(e.accountId);
    if (sync && !Number.isNaN(sync.ms) && occurred > sync.ms) {
      reasons.push(`Entry ${e.id} is dated ${e.occurredAt}, after account "${sync.label}" was last synced (${sync.raw}), so that sync cannot have seen it. Sync the account again.`);
      continue;
    }
    const inYear = occurred >= periodStart && occurred < periodEnd;
    if (inYear && e.direction === "in" && e.kind === "other") {
      reasons.push(`Entry ${e.id} is not classified yet. Tell us whether it is income, a transfer between your own accounts, or a refund.`);
      continue;
    }
    if (e.kind !== "income" || e.direction !== "in") continue;
    if (!inYear) continue;
    if (occurred > asOfMs) {
      reasons.push(`Entry ${e.id} is dated ${e.occurredAt}, after ${input.asOf}.`);
      continue;
    }
    if (!e.fx.statutory) {
      reasons.push(`Entry ${e.id} (${e.txHash}) has no official naira rate for its date.`);
      continue;
    }
    const q = e.fx.statutory;
    const qReason = checkStatutory(e, q, rules, asOfMs);
    if (qReason) {
      reasons.push(qReason);
      continue;
    }
    const txDate = localDate(occurred, rules.timezoneOffset);
    if (q.date !== txDate) {
      reasons.push(`Entry ${e.id}: the official rate is dated ${q.date} but the payment was on ${txDate}. Only a rate from the same day is accepted.`);
      continue;
    }
    // Absent means null or missing. Any other value (0, "", false) is a
    // malformed quote and is checked, never silently dropped.
    if (e.fx.economic !== null && e.fx.economic !== undefined) {
      const eReason = checkEconomic(e, e.fx.economic, rules, asOfMs);
      if (eReason) {
        reasons.push(eReason);
        continue;
      }
    }
    try {
      const amt = parseDec(e.amount);
      if (amt.scale > MAX_AMOUNT_DP) throw new RangeError("too many decimal places");
      const rate = parseDec(e.fx.statutory.ngnPerUnit);
      if (rate.n === 0n) throw new RangeError("rate is zero");
      parsed.push({ e, amt, rate });
    } catch {
      reasons.push(`Entry ${e.id} has an invalid amount or rate.`);
    }
  }

  let otherKobo: bigint | null = null;
  const scope = input.profile.incomeScope as Partial<Record<string, unknown>> | undefined;
  const SCOPE_MSG = "Tell us whether all your income for the year arrives in your linked accounts.";
  if (!scope || typeof scope.allIncomeInLinkedAccounts !== "boolean") {
    reasons.push(SCOPE_MSG);
  } else if (scope.allIncomeInLinkedAccounts === true) {
    const extra = Object.keys(scope).filter((k) => k !== "allIncomeInLinkedAccounts");
    if (extra.length > 0) {
      reasons.push(`${SCOPE_MSG} You said all income arrives in linked accounts, but also gave ${extra.join(", ")}. Those contradict each other.`);
    }
  } else {
    const extra = Object.keys(scope).filter((k) => !["allIncomeInLinkedAccounts", "otherIncomeNgn", "otherIncomeNote"].includes(k));
    if (extra.length > 0) reasons.push(`Income scope has unknown field(s): ${extra.join(", ")}.`);
    try {
      const d = parseTypedNaira(scope.otherIncomeNgn);
      if (d.scale > MAX_NAIRA_INPUT_DP) throw new RangeError("sub-kobo");
      otherKobo = toKobo(d);
    } catch {
      reasons.push(`${SCOPE_MSG} You said some income arrives elsewhere, so give that amount in naira with at most ${MAX_NAIRA_INPUT_DP} decimal places.`);
    }
  }

  let rentKobo: bigint | null = null;
  if (input.profile.annualRentNgn !== undefined) {
    try {
      const d = parseTypedNaira(input.profile.annualRentNgn);
      if (d.scale > MAX_NAIRA_INPUT_DP) throw new RangeError("sub-kobo");
      rentKobo = toKobo(d);
    } catch {
      reasons.push(`The annual rent in the profile is not a valid amount (naira with at most ${MAX_NAIRA_INPUT_DP} decimal places).`);
    }
  }

  if (reasons.length > 0) return refuse(reasons);

  // Income lines. Each line is rounded half up to kobo, then summed.
  const informational: Informational[] = [];
  const incomeLines: IncomeLine[] = [];
  let gross = 0n;
  // The assumptions behind each naira value travel with the result, so a
  // consumer that shows only the result still shows what qualifies it.
  const basisId = `${rules.valuation.id}:basis`;
  const assumed = new Set<string>();
  for (const { e, amt, rate } of parsed) {
    const q = e.fx.statutory!;
    const value = mulToKobo(amt, rate);
    gross += value;
    const assetId = `${rules.valuation.id}:assetBase:${e.asset}`;
    if (!assumed.has(assetId)) {
      if (assumed.size === 0) {
        informational.push({ kind: "valuation_basis", id: basisId, message: `Valuation basis (${rules.valuation.basis}): ${rules.valuation.note}` });
      }
      assumed.add(assetId);
      informational.push({ kind: "asset_assumption", id: assetId, message: rules.valuation.assetBaseNote });
    }
    const line: IncomeLine = {
      entryId: e.id,
      txHash: e.txHash,
      amount: e.amount,
      asset: e.asset,
      ngnPerUnit: q.ngnPerUnit,
      rateProvider: rules.valuation.statutoryProviders.find((p) => p.id === q.provider)!.name,
      ratePair: `${q.base}/${q.quote}`,
      rateDate: q.date,
      rateSourceUrl: q.sourceUrl,
      ruleId: rules.valuation.id,
      ngnValue: formatKobo(value),
      valuationBasis: rules.valuation.basis,
      assumptionIds: [basisId, assetId],
    };
    const ecq = e.fx.economic;
    if (ecq && ecq.date !== localDate(ms(e.occurredAt), rules.timezoneOffset)) {
      informational.push({
        kind: "fx_gap_omitted",
        id: e.id,
        message: `Entry ${e.id}: the market rate is dated ${ecq.date}, not the payment day, so the market value and gap are not shown.`,
      });
    } else if (ecq) {
      try {
        const econ = mulToKobo(amt, parseDec(ecq.ngnPerUnit));
        line.economicNgnValue = formatKobo(econ);
        line.economicQuote = { provider: ecq.provider, pair: `${ecq.base}/${ecq.quote}`, date: ecq.date, sourceUrl: ecq.sourceUrl };
        // The gap is a property of the two rates, not of the kobo-rounded line
        // values: on a tiny amount, rounding would distort it.
        const m = parseDec(ecq.ngnPerUnit);
        const scale = Math.max(rate.scale, m.scale);
        const sN = rate.n * 10n ** BigInt(scale - rate.scale);
        const mN = m.n * 10n ** BigInt(scale - m.scale);
        if (sN > 0n) {
          const diff = mN - sN;
          const abs = diff < 0n ? -diff : diff;
          const pct = formatRatio(abs * 100n, sN, 2);
          line.fxGapPct = diff < 0n && pct !== "0.00" ? `-${pct}` : pct;
        }
      } catch {
        // Unreachable: the economic quote was validated before valuation.
      }
    }
    incomeLines.push(line);
  }

  const declaredIncomeLines: DeclaredIncomeLine[] = [];
  if (otherKobo !== null) {
    const note = (scope as { otherIncomeNote?: unknown }).otherIncomeNote;
    declaredIncomeLines.push({
      label: typeof note === "string" && note.trim() !== "" ? note.trim() : "Other income declared by you",
      amountNgn: formatKobo(otherKobo),
      source: "declared by you",
    });
    gross += otherKobo;
    informational.push({
      kind: "declared_income",
      id: rules.virtualAssetIncome.id,
      message: `N${formatKobo(otherKobo)} of your income was declared by you and was not verified on chain. It is included in the total.`,
    });
  }

  // Reliefs.
  const reliefs: { ruleId: string; label: string; amountNgn: string }[] = [];
  let reliefTotal = 0n;
  const usedSources: SourceRef[] = [toSource(rules.virtualAssetIncome), toSource(rules.valuation), toSource(rules.pit)];
  if (rentKobo !== null) {
    const raw = koboTimesRate(rentKobo, parseDec(rules.rentRelief.rate));
    const cap = toKobo(parseDec(rules.rentRelief.capNgn));
    const amount = raw < cap ? raw : cap;
    reliefTotal += amount;
    reliefs.push({ ruleId: rules.rentRelief.id, label: "Rent relief", amountNgn: formatKobo(amount) });
    usedSources.push(toSource(rules.rentRelief));
  }

  const taxable = gross > reliefTotal ? gross - reliefTotal : 0n;

  // Bands.
  const bands: BandResult[] = [];
  let totalTax = 0n;
  for (const b of rules.pit.bands) {
    const lo = toKobo(parseDec(b.from));
    const hi = b.to === null ? null : toKobo(parseDec(b.to));
    const top = hi === null || taxable < hi ? taxable : hi;
    const inBand = top > lo ? top - lo : 0n;
    const tax = koboTimesRate(inBand, parseDec(b.rate));
    totalTax += tax;
    bands.push({
      from: formatKobo(lo),
      to: hi === null ? null : formatKobo(hi),
      rate: b.rate,
      taxableInBand: formatKobo(inBand),
      taxInBand: formatKobo(tax),
      ruleId: b.id,
    });
  }

  // Informational notes.
  informational.push({
    kind: "stamp_duty",
    id: rules.stampDuty.id,
    message: `Converting tokens to naira, or naira to tokens, may attract stamp duty (borne by the transferee) at ${formatRatio(
      parseDec(rules.stampDuty.rate).n * 100n,
      10n ** BigInt(parseDec(rules.stampDuty.rate).scale),
      2,
    )}%. It is not included in the tax total.`,
  });
  usedSources.push(toSource(rules.stampDuty));
  for (const n of rules.notModelled) {
    informational.push({ kind: "not_modelled", id: n.id, message: `${n.title}: ${n.reason}` });
  }

  return {
    status: "ok",
    taxYear: input.taxYear,
    currency: "NGN",
    grossIncomeNgn: formatKobo(gross),
    reliefs,
    taxableIncomeNgn: formatKobo(taxable),
    bands,
    totalTaxNgn: formatKobo(totalTax),
    effectiveRate: gross === 0n ? "0.0000" : formatRatio(totalTax, gross, 4),
    incomeLines,
    declaredIncomeLines,
    informational,
    sources: usedSources,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Stamp duty notice for the cash-out screen. Information only: it never
 * computes an amount and never deducts anything from the user's payout,
 * because the rule says the transferee (the party receiving the tokens) bears
 * the duty, and on a cash-out that is the buyer, not the user. Decided by
 * Joshua on 2026-11-25 after review.
 */
export function stampDutyNotice(rules: Rules): {
  status: "requires_review";
  ratePct: string;
  borneBy: "transferee";
  message: string;
  ruleId: string;
  source: SourceRef;
} {
  const r = parseDec(rules.stampDuty.rate);
  const ratePct = formatRatio(r.n * 100n, 10n ** BigInt(r.scale), 2);
  return {
    status: "requires_review",
    ratePct,
    borneBy: "transferee",
    message: `Stamp duty of ${ratePct}% may apply to this conversion. Under the rule cited, the party receiving the tokens bears it, so nothing is taken from your payout here. This needs review by a tax practitioner.`,
    ruleId: rules.stampDuty.id,
    source: toSource(rules.stampDuty),
  };
}
