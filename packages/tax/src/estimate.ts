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

function ms(iso: string): number {
  return Date.parse(iso);
}

/** Local calendar date (YYYY-MM-DD) of an instant, in the rules' timezone. */
function localDate(instantMs: number, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h = "0", m = "0"] = offset.slice(1).split(":");
  const shift = sign * (Number(h) * 60 + Number(m)) * 60_000;
  return new Date(instantMs + shift).toISOString().slice(0, 10);
}

export function estimate(input: EstimateInput): EstimateResult {
  const rules = getRules(input.country, input.taxYear);
  if (!rules) {
    return refuse([`No tax rules for ${input.country} ${input.taxYear}.`]);
  }

  const reasons: string[] = [];
  const asOfMs = ms(input.asOf);
  if (Number.isNaN(asOfMs)) return refuse([`asOf is not a valid date: ${input.asOf}`]);

  const periodStart = ms(`${input.taxYear}-01-01T00:00:00${rules.timezoneOffset}`);
  const periodEnd = ms(`${input.taxYear + 1}-01-01T00:00:00${rules.timezoneOffset}`);
  const staleMs = (input.staleAfterHours ?? DEFAULT_STALE_HOURS) * 3_600_000;

  // Accounts: freshness and gaps.
  for (const a of input.accounts) {
    const synced = ms(a.lastSyncedAt);
    if (Number.isNaN(synced)) {
      reasons.push(`Account "${a.label}" has an invalid last sync time.`);
    } else if (asOfMs - synced > staleMs) {
      reasons.push(`Account "${a.label}" was last synced at ${a.lastSyncedAt}, which is too old. Sync it again.`);
    }
    for (const g of a.gaps) {
      const from = ms(g.from);
      const to = ms(g.to);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        reasons.push(`Account "${a.label}" has a gap with an invalid date.`);
      } else if (from < periodEnd && to >= periodStart) {
        reasons.push(`Account "${a.label}" has missing history from ${g.from} to ${g.to}, inside ${input.taxYear}.`);
      }
    }
  }

  // Income entries.
  type Parsed = { e: (typeof input.entries)[number]; amt: Dec; rate: Dec; occurred: number };
  const parsed: Parsed[] = [];
  for (const e of input.entries) {
    if (e.kind !== "income" || e.direction !== "in") continue;
    const occurred = ms(e.occurredAt);
    if (Number.isNaN(occurred)) {
      reasons.push(`Entry ${e.id} has an invalid date.`);
      continue;
    }
    if (occurred < periodStart || occurred >= periodEnd) continue;
    if (!e.fx.statutory) {
      reasons.push(`Entry ${e.id} (${e.txHash}) has no official naira rate for its date.`);
      continue;
    }
    try {
      const amt = parseDec(e.amount);
      if (amt.scale > MAX_AMOUNT_DP) throw new RangeError("too many decimal places");
      const rate = parseDec(e.fx.statutory.ngnPerUnit);
      if (rate.n === 0n) throw new RangeError("rate is zero");
      parsed.push({ e, amt, rate, occurred });
    } catch {
      reasons.push(`Entry ${e.id} has an invalid amount or rate.`);
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
  for (const { e, amt, rate, occurred } of parsed) {
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
        // An unusable economic quote is only informational, so it is left out.
      }
    }
    const txDate = localDate(occurred, rules.timezoneOffset);
    if (q.date !== txDate) {
      informational.push({
        kind: "rate_date",
        id: rules.valuation.id,
        message: `Entry ${e.id}: the official rate is dated ${q.date} but the payment was on ${txDate}.`,
      });
    }
    incomeLines.push(line);
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
