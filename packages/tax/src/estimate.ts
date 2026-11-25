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
  Rules,
  SourceRef,
} from "./types";

export const DISCLAIMER = "This is an estimate, not tax advice.";
const DEFAULT_STALE_HOURS = 24;
const MAX_AMOUNT_DP = 7;

const toSource = (r: { id: string; citation: string; url: string; confidence: SourceRef["confidence"] }): SourceRef => ({
  ruleId: r.id,
  citation: r.citation,
  url: r.url,
  confidence: r.confidence,
});

function refuse(reasons: string[]): EstimateResult {
  return { status: "refused", reasons, disclaimer: DISCLAIMER };
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses an instant that must carry Z or a numeric offset. NaN when it does not. */
function ms(iso: string): number {
  if (typeof iso !== "string" || !INSTANT_RE.test(iso)) return Number.NaN;
  return Date.parse(iso);
}

/** True only for a real calendar date written YYYY-MM-DD. */
function validDate(d: unknown): d is string {
  if (typeof d !== "string" || !DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

const nonEmpty = (s: unknown): boolean => typeof s === "string" && s.trim() !== "";

/** Local calendar date (YYYY-MM-DD) of an instant, in the rules' timezone. */
function localDate(instantMs: number, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h = "0", m = "0"] = offset.slice(1).split(":");
  const shift = sign * (Number(h) * 60 + Number(m)) * 60_000;
  return new Date(instantMs + shift).toISOString().slice(0, 10);
}

/**
 * `rulesOverride` exists so tests can exercise a rules file the registry does
 * not hold. Production callers leave it out.
 */
export function estimate(input: EstimateInput, rulesOverride?: Rules): EstimateResult {
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
    const cov = ms(a.coverageFrom);
    let required = periodStart;
    let openedOk = true;
    if (a.openedAt !== undefined) {
      const opened = ms(a.openedAt);
      if (Number.isNaN(opened)) {
        openedOk = false;
        reasons.push(`Account "${a.label}": openedAt is not a valid date with a Z or +HH:MM offset.`);
      } else if (opened > required) {
        required = opened;
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
        reasons.push(`Account "${a.label}": a gap has a from or to that is not a valid date with a Z or +HH:MM offset.`);
      } else if (from > to) {
        reasons.push(`Account "${a.label}" has a gap that ends before it starts (${g.from} to ${g.to}).`);
      } else if (from < periodEnd && to >= periodStart) {
        reasons.push(`Account "${a.label}" has missing history from ${g.from} to ${g.to}, inside ${input.taxYear}.`);
      }
    }
  }

  // Income entries.
  type Parsed = { e: (typeof input.entries)[number]; amt: Dec; rate: Dec };
  const parsed: Parsed[] = [];
  const seenIds = new Set<string>();
  const accountIds = new Set(input.accounts.map((a) => a.id));
  for (const e of input.entries) {
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
    if (!nonEmpty(q.source)) {
      reasons.push(`Entry ${e.id}: the official naira rate has no source.`);
      continue;
    }
    if (!validDate(q.date)) {
      reasons.push(`Entry ${e.id}: the official rate date is not a valid YYYY-MM-DD date.`);
      continue;
    }
    const txDate = localDate(occurred, rules.timezoneOffset);
    if (q.date !== txDate) {
      reasons.push(`Entry ${e.id}: the official rate is dated ${q.date} but the payment was on ${txDate}. Only a rate from the same day is accepted.`);
      continue;
    }
    if (e.fx.economic) {
      const ec = e.fx.economic;
      let econOk = nonEmpty(ec.source) && validDate(ec.date);
      if (econOk) {
        try {
          if (parseDec(ec.ngnPerUnit).n === 0n) econOk = false;
        } catch {
          econOk = false;
        }
      }
      if (!econOk) {
        reasons.push(`Entry ${e.id}: the market rate is malformed or has no source.`);
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
  } else if (scope.allIncomeInLinkedAccounts === false) {
    try {
      otherKobo = toKobo(parseDec(scope.otherIncomeNgn as string));
    } catch {
      reasons.push(`${SCOPE_MSG} You said some income arrives elsewhere, so give that amount in naira.`);
    }
  }

  let rentKobo: bigint | null = null;
  if (input.profile.annualRentNgn !== undefined) {
    try {
      rentKobo = toKobo(parseDec(input.profile.annualRentNgn));
    } catch {
      reasons.push("The annual rent in the profile is not a valid amount.");
    }
  }

  if (reasons.length > 0) return refuse(reasons);

  // Income lines. Each line is rounded half up to kobo, then summed.
  const informational: Informational[] = [];
  const incomeLines: IncomeLine[] = [];
  let gross = 0n;
  for (const { e, amt, rate } of parsed) {
    const q = e.fx.statutory!;
    const value = mulToKobo(amt, rate);
    gross += value;
    const line: IncomeLine = {
      entryId: e.id,
      txHash: e.txHash,
      amount: e.amount,
      asset: e.asset,
      ngnPerUnit: q.ngnPerUnit,
      rateSource: q.source,
      ruleId: rules.valuation.id,
      ngnValue: formatKobo(value),
    };
    if (e.fx.economic) {
      try {
        const econ = mulToKobo(amt, parseDec(e.fx.economic.ngnPerUnit));
        line.economicNgnValue = formatKobo(econ);
        if (value > 0n) {
          const diff = econ - value;
          const abs = diff < 0n ? -diff : diff;
          const pct = formatRatio(abs * 100n, value, 2);
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
