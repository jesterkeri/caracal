# @caracal/tax

Tax estimate engine for Caracal, a wallet for Nigerian freelancers paid in USDC on Stellar.

WARNING: every 2026 figure here comes from SECONDARY sources (Big-4 and law-firm summaries). None has been checked against the gazetted Act or the NRS circular text. Check every rate, band and citation in `rules/NG/2026.json` against the gazetted Act before anyone relies on the output.

The output is always an estimate: `disclaimer: "This is an estimate, not tax advice."`.

## Design

- Pure functions. No network, no database, no clock reads. `asOf` is an input.
- No runtime dependencies. Money is `bigint` in integer minor units, with exact decimal parsing. USDC has 7 decimals. No floats.
- Tax rules are data in `rules/<country>/<year>.json`, loaded by `getRules(country, year)`. Logic never hardcodes a rate or band. A new year is a new JSON file plus one line in `src/rules.ts`.
- A later primary-source pass only edits the JSON: change `citation`, `url`, `confidence` and `verifiedOn`, and any number that turns out wrong.

## API

- `estimate(input: EstimateInput): EstimateResult`
- `stampDutyOnCashout(amountNgn, rules)` returns `{ duty, rate, ruleId, source }`
- `getRules(country, year)` returns the rules or `null`

Types are in `src/types.ts`.

### Input

`{ country: "NG", taxYear, asOf, entries, accounts, profile: { annualRentNgn? }, staleAfterHours? }`

Only entries with `kind: "income"`, `direction: "in"` and `occurredAt` inside the tax year count. `own_transfer`, `split_internal` and every other kind are never income. The tax year runs from 1 January 00:00 to 31 December 24:00 in the rules' timezone (Nigeria, +01:00).

### Output (status "ok")

`grossIncomeNgn`, `reliefs`, `taxableIncomeNgn`, `bands` (each with `ruleId`), `totalTaxNgn`, `effectiveRate`, `incomeLines`, `informational`, `sources`, `disclaimer`.

Every number traces to a rule: bands, reliefs and income lines carry a `ruleId`, and `sources` lists the citation, url and `confidence` of each rule used, so the UI can badge secondary sources.

Each income line has the statutory rate and its source. If an economic (market) quote is present it also has `economicNgnValue` and `fxGapPct`. The gap is (economic - statutory) / statutory, in percent, 2 dp. Positive means the market value is higher than the official value.

### Rounding

Naira values are decimal strings with 2 dp. Rounding is half up, to the kobo. Each income line (amount times rate) is rounded once, and gross income is the sum of the rounded lines. Each band's tax is rounded once. `effectiveRate` is total tax divided by gross income, as a fraction with 4 dp ("0.1234"), and "0.0000" when there is no income.

## Refusal rules

The result is `{ status: "refused", reasons: [...], disclaimer }` with no numbers when any of these hold:

- An in-year income entry has no statutory naira rate (or an invalid amount or rate).
- An account's `lastSyncedAt` is older than `staleAfterHours` (default 24) before `asOf`.
- An account has a gap that overlaps the tax year.
- There are no rules for the country and year.
- The profile rent is not a valid amount, or `asOf` is not a valid date.

## Sources and confidence

| Rule | Confidence |
| --- | --- |
| PIT bands (NG-2026-PIT) | secondary |
| Rent relief, 20% capped at N500,000 (NG-2026-RELIEF-RENT) | secondary |
| Professional fees in virtual assets are income (NG-2026-VA-INCOME) | secondary |
| Valuation at the official rate (NG-2026-VA-VALUATION) | secondary, basis "analogy" |
| Stamp duty 1.5% (NG-2026-STAMP-CONVERSION) | secondary |

Valuation: the circular states the conversion rule explicitly for gains and for employment income, but not for professional fees. Caracal applies the official rate on the receipt date by analogy. If the supplied rate is dated differently from the payment date (Nigeria time), an `informational` note says so.

Stamp duty is reported as information and through `stampDutyOnCashout`. It is not added to the tax total.

## Not modelled

Listed in the rules as `notModelled` and surfaced in `informational`:

- Withholding tax on professional fees paid in crypto. WHT applies to payments for services made in virtual assets (KPMG, PwC), but no source states the rate for professional fees. Not modelled until the circular text is read.
- 1% WHT on disposal proceeds (Categories 1, 3, 5), circular para 8.0. KPMG says it lacks a basis in the NTA. Disposals are out of scope.

## Tests

`pnpm -C packages/tax test` (single fork) and `pnpm -C packages/tax typecheck`.
