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
- `stampDutyNotice(rules)` returns `{ status: "requires_review", ratePct, borneBy, message, ruleId, source }`. It never computes a naira amount.
- `getRules(country, year)` returns the rules or `null`

Types are in `src/types.ts`.

### Input

`{ country: "NG", taxYear, asOf, entries, accounts, profile: { annualRentNgn?, incomeScope }, staleAfterHours? }`

- Entry: `id`, `accountId` (must be one of `accounts`), `txHash`, `occurredAt`, `direction`, `kind`, `asset`, `amount`, `fx: { statutory, economic }`.
- Account: `id`, `label`, `lastSyncedAt`, `coverageFrom` (the instant from which its history is complete), optional `openedAt` (when the account came into existence), `gaps`.
- `incomeScope` is required: `{ allIncomeInLinkedAccounts: true }`, or `{ allIncomeInLinkedAccounts: false, otherIncomeNgn, otherIncomeNote? }`.
- Every instant (`asOf`, `occurredAt`, `lastSyncedAt`, `coverageFrom`, `openedAt`, gap `from` and `to`) must end in `Z` or a numeric offset like `+01:00`. Without an offset, JavaScript reads the time in the host's timezone, so a New Year's Eve payment could land in a different tax year depending on where the code runs. Quote dates are plain `YYYY-MM-DD`.
- `estimate(input, rulesOverride?)`: the second argument is for tests only.

Only entries with `kind: "income"`, `direction: "in"` and `occurredAt` inside the tax year count. `own_transfer`, `split_internal`, `cashout` and `refund` are never income. An in-year incoming `other` entry is not ignored: it makes the estimate refuse until the user classifies it. The tax year runs from 1 January 00:00 to 31 December 24:00 in the rules' timezone (Nigeria, +01:00).

### Output (status "ok")

`grossIncomeNgn`, `reliefs`, `taxableIncomeNgn`, `bands` (each with `ruleId`), `totalTaxNgn`, `effectiveRate`, `incomeLines`, `declaredIncomeLines`, `informational`, `sources`, `disclaimer`.

Every number traces to a rule: bands, reliefs and income lines carry a `ruleId`, and `sources` lists the citation, url and `confidence` of each rule used, so the UI can badge secondary sources.

Each income line has the statutory rate and its source. If an economic (market) quote is present it also has `economicNgnValue` and `fxGapPct`. The gap is (economic - statutory) / statutory, in percent, 2 dp. Positive means the market value is higher than the official value.

Income the user declares through `incomeScope` appears in `declaredIncomeLines` as `{ label, amountNgn, source: "declared by you" }`, is added to gross income, and an `informational` note says it was not verified on chain.

### Rounding

Naira values are decimal strings with 2 dp. Rounding is half up, to the kobo. Each income line (amount times rate) is rounded once, and gross income is the sum of the rounded lines. Each band's tax is rounded once. `effectiveRate` is total tax divided by gross income, as a fraction with 4 dp ("0.1234"), and "0.0000" when there is no income.

## Refusal rules

The result is `{ status: "refused", reasons: [...], disclaimer }` with no numbers when any of these hold:

- An in-year income entry has no statutory naira rate, or an invalid amount or rate.
- A statutory quote has an empty source, a date that is not a real `YYYY-MM-DD`, or a date that fails the rate date rule (see below).
- `fx.economic` is present but malformed, has a zero or invalid rate, an empty source or a bad date. It is never silently dropped.
- The rules file names a `valuation.rateDateRule` other than `"same_day"`.
- An account's `lastSyncedAt` is older than `staleAfterHours` (default 24) before `asOf`, or after `asOf`.
- An account's `coverageFrom` is later than the later of the tax year start and its `openedAt`. Being synced today proves nothing about last March.
- An account has a gap that overlaps the tax year, or a gap whose `from` is after its `to`.
- There are no linked accounts.
- An entry's `accountId` is not one of the linked accounts, or an entry id appears twice.
- An in-year incoming entry has `kind: "other"` (not classified yet).
- `incomeScope` is missing, or says income arrives elsewhere without a valid `otherIncomeNgn`.
- Any instant has no `Z` or numeric offset, or is not a valid date.
- There are no rules for the country and year, or the profile rent is not a valid amount.

An empty ledger is a valid input. With every account proven complete for the year it returns zero income and zero tax.

## Rate date rule and income scope

`valuation.rateDateRule` is data in the rules JSON. The only supported value is `"same_day"`: the statutory quote's date must equal the receipt's calendar date in Lagos time (the rules' `timezoneOffset`). A quote from any other day refuses. There is no lookback window because no source we have read allows one, and guessing a window would put a confident but unsourced number on screen. If a source later allows a lookback, add a new rule name and engine support for it together.

Income scope: the ledger only sees linked accounts. The user must say whether all their income for the year arrives there. If not, they give the naira amount that arrives elsewhere. It is taxed as declared and labelled as unverified, so the result never pretends to cover income it cannot see.

## Sources and confidence

| Rule | Confidence |
| --- | --- |
| PIT bands (NG-2026-PIT) | secondary |
| Rent relief, 20% capped at N500,000 (NG-2026-RELIEF-RENT) | secondary |
| Professional fees in virtual assets are income (NG-2026-VA-INCOME) | secondary |
| Valuation at the official rate (NG-2026-VA-VALUATION) | secondary, basis "analogy" |
| Stamp duty 1.5% (NG-2026-STAMP-CONVERSION) | secondary |

Valuation: the circular states the conversion rule explicitly for gains and for employment income, but not for professional fees. Caracal applies the official rate on the receipt date by analogy. The rate must be dated the same day as the payment (Nigeria time), otherwise the estimate refuses.

Stamp duty is information only. The cited rule says the transferee (the party receiving the tokens) bears it, and on a cash-out that is the buyer, not the user. So Caracal shows a sourced notice and deducts nothing. It is never added to the tax total.

## Not modelled

Listed in the rules as `notModelled` and surfaced in `informational`:

- Withholding tax on professional fees paid in crypto. WHT applies to payments for services made in virtual assets (KPMG, PwC), but no source states the rate for professional fees. Not modelled until the circular text is read.
- 1% WHT on disposal proceeds (Categories 1, 3, 5), circular para 8.0. KPMG says it lacks a basis in the NTA. Disposals are out of scope.

## Tests

`pnpm -C packages/tax test` (single fork) and `pnpm -C packages/tax typecheck`.
