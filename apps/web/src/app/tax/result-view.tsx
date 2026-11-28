"use client";

// Shows what /tax/estimate answered. Every naira figure here is the engine's,
// shown with its rule and source; a refusal shows its reasons and no numbers.

import { explorerLink } from "@/lib/stellar/config";
import type { Estimate } from "@caracal/tax";
import type { Context, PaymentRow, TaxOutcome } from "@/lib/tax/pipeline";

export const NOT_ADVICE = "Estimate, not tax advice.";

/** "1234567.5" to "1,234,567.5". Text only, so no float rounding can touch it. */
export function group(amount: string): string {
  const [whole = "", frac] = amount.split(".");
  const g = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? g : `${g}.${frac}`;
}

/**
 * A rate written as a fraction ("0.1000", "0.075") shown as a percentage ("10%", "7.5%"). The text is shifted by
 * two decimal places as text, so no float rounding can touch it; anything that is not a plain decimal is shown as is.
 */
export function pct(rate: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!m) return rate;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const whole = `${m[1]}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const rest = frac.slice(2).replace(/0+$/, "");
  return `${whole}${rest === "" ? "" : `.${rest}`}%`;
}

const naira = (s: string) => `N${group(s)}`;
const time = (iso: string) => iso.replace("T", " ").replace("Z", " UTC");

/** What was read. Under a refusal (`estimated` false) it claims no coverage: no estimate was made (adversary t18). */
function Coverage({ c, estimated }: { c: Context; estimated: boolean }) {
  if (!estimated) {
    return (
      <section className="card text-sm leading-relaxed">
        <h2 className="h2">What this is based on</h2>
        <p>
          Payments into your split contract{" "}
          <a className="link addr" href={explorerLink("contract", c.splitContract)}>
            {c.splitContract}
          </a>
          , read from Stellar testnet, from {time(c.coverage.from)} (ledger {c.coverage.fromLedger}) through ledger {c.coverage.toLedger}, which closed at {time(c.coverage.to)}. The
          public Stellar RPC keeps only a short window of history, so nothing earlier could be read. No estimate was made from these payments, for the reasons above.
        </p>
        <p>
          Payments found in that window: {c.paymentsInWindow}, of which {c.paymentsInTaxYear} fall in {c.taxYear} (Nigeria time). Checked {time(c.asOf)}.
        </p>
      </section>
    );
  }
  return (
    <section className="card text-sm leading-relaxed">
      <h2 className="h2">What this is based on</h2>
      <p>
        Payments into your split contract{" "}
        <a className="link addr" href={explorerLink("contract", c.splitContract)}>
          {c.splitContract}
        </a>
        , read from Stellar testnet.
      </p>
      <p>
        Covers payments your split contract recorded through ledger {c.coverage.toLedger}, which closed at {time(c.coverage.to)}. A payment recorded after that ledger is not in this
        estimate. Caracal checked that no new event arrived in the contract between reading its payments and fixing that ledger.
      </p>
      <p>
        History checked from {time(c.coverage.from)} (ledger {c.coverage.fromLedger}). The public Stellar RPC keeps only a short window of history, so nothing earlier could be read. An
        estimate is made only when this window covers {c.taxYear} from its start, or from the day your split contract was created (its creation record is in the window), so no
        payment recorded up to that ledger is missing.
      </p>
      <p>
        Payments found in that window: {c.paymentsInWindow}, of which {c.paymentsInTaxYear} fall in {c.taxYear} (Nigeria time). Computed {time(c.asOf)}.
      </p>
    </section>
  );
}

function Money({ e, excluded }: { e: Estimate; excluded: PaymentRow[] }) {
  return (
    <div className="flex flex-col gap-5 text-sm">
      <section className="card card-hero gap-2 bg-none bg-[var(--c-brown)]">
        <h2 className="h3 opacity-80">Your {e.taxYear} estimate</h2>
        <p className="money-xl num break-words">{naira(e.totalTaxNgn)}</p>
        <p className="opacity-90 leading-relaxed">
          Estimated tax on {naira(e.taxableIncomeNgn)} taxable income ({naira(e.grossIncomeNgn)} income). Effective rate {pct(e.effectiveRate)}. {NOT_ADVICE}
        </p>
      </section>

      <section className="list">
        <h2 className="h2 mb-1">Income, payment by payment</h2>
        {e.incomeLines.length === 0 && <p>No income payments in {e.taxYear} were found in the history window.</p>}
        {e.incomeLines.map((l) => (
          <div key={l.entryId} className="item kv gap-0 py-1.5">
            <p className="kv-row num text-base">
              {group(l.amount)} {l.asset} = <strong>{naira(l.ngnValue)}</strong>
            </p>
            <p className="kv-row muted text-sm">
              Rate: {group(l.ngnPerUnit)} naira per US dollar ({l.ratePair}), {l.rateProvider}, dated {l.rateDate}.{" "}
              <a className="link shrink-0" href={l.rateSourceUrl}>
                Rate source
              </a>
            </p>
            <p className="kv-row block muted text-sm">
              <a className="link" href={explorerLink("tx", l.txHash)}>
                Transaction
              </a>
              . Rule {l.ruleId}. Valuation basis: {l.valuationBasis}. Notes: {l.assumptionIds.join(", ") || "none"}.
            </p>
          </div>
        ))}
        {excluded.length > 0 && (
          <div className="item card-sunken shadow-none">
            <p className="font-medium">Left out by your own answer (you said these are not income; Caracal did not check this on chain):</p>
            {excluded.map((p) => (
              <p key={p.id} className="kv-row num text-sm">
                {p.date}: {group(p.amount)} {p.asset} from <span className="addr">{p.from}</span>, invoice reference {p.invoiceRef || "none"}
              </p>
            ))}
          </div>
        )}
        {e.declaredIncomeLines.map((l, i) => (
          <div key={i} className="item card-sunken shadow-none">
            <p className="num">
              {l.label}: <strong>{naira(l.amountNgn)}</strong> ({l.source}, not checked on chain)
            </p>
          </div>
        ))}
      </section>

      <section className="card kv gap-0">
        <h2 className="h2 mb-1">How the tax is worked out</h2>
        {e.reliefs.map((r) => (
          <p key={r.ruleId} className="kv-row num text-sm">
            Relief, {r.label}: {naira(r.amountNgn)} (rule {r.ruleId})
          </p>
        ))}
        {e.reliefs.length === 0 && <p>No reliefs applied.</p>}
        {e.bands.map((b) => (
          <p key={b.ruleId} className="kv-row num text-sm">
            {naira(b.from)} to {b.to === null ? "no limit" : naira(b.to)} at {pct(b.rate)}: {naira(b.taxableInBand)} taxed, {naira(b.taxInBand)} tax (rule {b.ruleId})
          </p>
        ))}
      </section>

      <section className="card">
        <h2 className="h2">Notes and assumptions</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 leading-relaxed">
          {e.informational.map((n) => (
            <li key={n.id}>
              {n.message} <span className="muted font-mono text-xs">({n.id})</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="h2">Sources</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 leading-relaxed">
          {e.sources.map((s) => (
            <li key={s.ruleId}>
              {s.ruleId}: {s.citation}.{" "}
              <a className="link break-all" href={s.url}>
                {s.url}
              </a>{" "}
              (confidence: {s.confidence})
            </li>
          ))}
        </ul>
        <p className="notice">
          Most of these figures come from secondary sources (summaries by accounting and law firms), not the gazetted law. Check them before relying on them.
        </p>
      </section>
    </div>
  );
}

export function ResultView({ outcome }: { outcome: TaxOutcome }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="notice notice-strong">{NOT_ADVICE}</p>
      {outcome.status === "ok" && (
        <>
          <Money e={outcome.estimate} excluded={outcome.context.excludedByAnswer} />
          <Coverage c={outcome.context} estimated />
        </>
      )}
      {outcome.status === "refused" && (
        <>
          <section className="card text-sm leading-relaxed">
            <h2 className="h2">No estimate: Caracal refused to guess</h2>
            <p>The estimate was not made, because a number built on missing or unproven data could lead to a wrong decision. Reasons:</p>
            <ul className="flex list-disc flex-col gap-2 pl-5">
              {outcome.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </section>
          {outcome.context && <Coverage c={outcome.context} estimated={false} />}
        </>
      )}
      {outcome.status === "unavailable" && (
        <section className="msg msg-bad flex flex-col gap-1">
          <h2 className="h3">No estimate</h2>
          <p>{outcome.message}</p>
        </section>
      )}
      {outcome.status === "no-contract" && (
        <section className="msg msg-info flex flex-col gap-2">
          <h2 className="h3">No estimate</h2>
          <p>{outcome.message}</p>
          <p className="addr addr-box bg-[var(--c-card)]">{outcome.splitContract}</p>
        </section>
      )}
    </div>
  );
}
