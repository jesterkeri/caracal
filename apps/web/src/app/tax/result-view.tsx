"use client";

// Shows what /tax/estimate answered. Every naira figure here is the engine's,
// shown with its rule and source; a refusal shows its reasons and no numbers.

import { explorerLink } from "@/lib/stellar/config";
import type { Estimate } from "@caracal/tax";
import type { Context, TaxOutcome } from "@/lib/tax/pipeline";

export const NOT_ADVICE = "Estimate, not tax advice.";

/** "1234567.5" to "1,234,567.5". Text only, so no float rounding can touch it. */
export function group(amount: string): string {
  const [whole = "", frac] = amount.split(".");
  const g = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? g : `${g}.${frac}`;
}

const naira = (s: string) => `N${group(s)}`;
const time = (iso: string) => iso.replace("T", " ").replace("Z", " UTC");

function Coverage({ c }: { c: Context }) {
  return (
    <section className="flex flex-col gap-1 text-sm">
      <h2 className="font-semibold">What this is based on</h2>
      <p>
        Payments into your split contract{" "}
        <a className="break-all font-mono underline" href={explorerLink("contract", c.splitContract)}>
          {c.splitContract}
        </a>
        , read from Stellar testnet.
      </p>
      <p>
        History checked: {time(c.coverage.from)} to {time(c.coverage.to)} (ledgers {c.coverage.fromLedger} to {c.coverage.toLedger}). The public Stellar RPC keeps only a short window of
        history, so nothing earlier could be read. The estimate is only made when this window covers the whole of {c.taxYear}.
      </p>
      <p>
        Payments found in that window: {c.paymentsInWindow}, of which {c.paymentsInTaxYear} fall in {c.taxYear} (Nigeria time). Estimate made {time(c.asOf)}.
      </p>
    </section>
  );
}

function Money({ e }: { e: Estimate }) {
  return (
    <div className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-1">
        <h2 className="font-semibold">Your {e.taxYear} estimate</h2>
        <p className="text-2xl font-semibold">{naira(e.totalTaxNgn)}</p>
        <p>
          Estimated tax on {naira(e.taxableIncomeNgn)} taxable income ({naira(e.grossIncomeNgn)} income). Effective rate {e.effectiveRate}. {NOT_ADVICE}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Income, payment by payment</h2>
        {e.incomeLines.length === 0 && <p>No income payments in {e.taxYear} were found in the history window.</p>}
        {e.incomeLines.map((l) => (
          <div key={l.entryId} className="flex flex-col gap-1 rounded-md border p-3">
            <p>
              {group(l.amount)} {l.asset} = <strong>{naira(l.ngnValue)}</strong>
            </p>
            <p>
              Rate: {group(l.ngnPerUnit)} naira per US dollar ({l.ratePair}), {l.rateProvider}, dated {l.rateDate}.{" "}
              <a className="underline" href={l.rateSourceUrl}>
                Rate source
              </a>
            </p>
            <p>
              <a className="underline" href={explorerLink("tx", l.txHash)}>
                Transaction
              </a>
              . Rule {l.ruleId}. Valuation basis: {l.valuationBasis}. Notes: {l.assumptionIds.join(", ") || "none"}.
            </p>
          </div>
        ))}
        {e.declaredIncomeLines.map((l, i) => (
          <div key={i} className="rounded-md border p-3">
            <p>
              {l.label}: <strong>{naira(l.amountNgn)}</strong> ({l.source}, not checked on chain)
            </p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">How the tax is worked out</h2>
        {e.reliefs.map((r) => (
          <p key={r.ruleId}>
            Relief, {r.label}: {naira(r.amountNgn)} (rule {r.ruleId})
          </p>
        ))}
        {e.reliefs.length === 0 && <p>No reliefs applied.</p>}
        {e.bands.map((b) => (
          <p key={b.ruleId}>
            {naira(b.from)} to {b.to === null ? "no limit" : naira(b.to)} at {b.rate}: {naira(b.taxableInBand)} taxed, {naira(b.taxInBand)} tax (rule {b.ruleId})
          </p>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Notes and assumptions</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {e.informational.map((n) => (
            <li key={n.id}>
              {n.message} <span className="opacity-70">({n.id})</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Sources</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {e.sources.map((s) => (
            <li key={s.ruleId}>
              {s.ruleId}: {s.citation}.{" "}
              <a className="break-all underline" href={s.url}>
                {s.url}
              </a>{" "}
              (confidence: {s.confidence})
            </li>
          ))}
        </ul>
        <p>
          Most of these figures come from secondary sources (summaries by accounting and law firms), not the gazetted law. Check them before relying on them.
        </p>
      </section>
    </div>
  );
}

export function ResultView({ outcome }: { outcome: TaxOutcome }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-md border px-3 py-2 text-sm font-semibold">{NOT_ADVICE}</p>
      {outcome.status === "ok" && (
        <>
          <Money e={outcome.estimate} />
          <Coverage c={outcome.context} />
        </>
      )}
      {outcome.status === "refused" && (
        <>
          <section className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">No estimate: Caracal refused to guess</h2>
            <p>The estimate was not made, because a number built on missing or unproven data could lead to a wrong decision. Reasons:</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {outcome.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </section>
          {outcome.context && <Coverage c={outcome.context} />}
        </>
      )}
      {outcome.status === "unavailable" && (
        <section className="flex flex-col gap-2 text-sm">
          <h2 className="font-semibold">No estimate</h2>
          <p>{outcome.message}</p>
        </section>
      )}
      {outcome.status === "no-contract" && (
        <section className="flex flex-col gap-2 text-sm">
          <h2 className="font-semibold">No estimate</h2>
          <p>{outcome.message}</p>
          <p className="break-all font-mono">{outcome.splitContract}</p>
        </section>
      )}
    </div>
  );
}
