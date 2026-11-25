# @caracal/tax

Tax estimate engine for Caracal, a wallet for Nigerian freelancers paid in USDC on Stellar.

WARNING: every 2026 figure here comes from SECONDARY sources (Big-4 and law-firm summaries). None has been checked against the gazetted Act or the NRS circular text. Check every rate, band and citation in `rules/NG/2026.json` against the gazetted Act before anyone relies on the output.

The output is always an estimate: `disclaimer: "This is an estimate, not tax advice."`.

## Design

- Pure functions. No network, no database, no clock reads. `asOf` is an input.
- No runtime dependencies. Money is `bigint` in integer minor units, with exact decimal parsing. Ledger amounts and rates must be plain decimals with no surrounding whitespace; naira the user types (`otherIncomeNgn`, `annualRentNgn`) is trimmed first. USDC has 7 decimals. No floats.
- Tax rules are data in `rules/<country>/<year>.json`, loaded by `getRules(country, year)`. Logic never hardcodes a rate or band. A new year is a new JSON file plus one line in `src/rules.ts`.
- A later primary-source pass only edits the JSON: change `citation`, `url`, `confidence` and `verifiedOn`, and any number that turns out wrong.

## API

- `estimate(input: EstimateInput): EstimateResult`
- `stampDutyNotice(rules)` returns `{ status: "requires_review", ratePct, borneBy, message, ruleId, source }`. It never computes a naira amount.
- `getRules(country, year)` returns the rules or `null`

Types are in `src/types.ts`.

### Input

`{ country: "NG", taxYear, asOf, entries, accounts, profile: { annualRentNgn?, incomeScope }, staleAfterHours? }`

- Entry: `id`, `accountId` (must be one of `accounts`), `txHash`, `occurredAt`, `direction`, `kind`, `asset`, `amount`, `fx: { statutory, economic }`, each quote an `FxQuote` (see below).
- Account: `id`, `label`, `lastSyncedAt`, `coverageFrom` (the instant from which its history is complete), optional `openedAt` (when the account came into existence), `gaps`.
- `incomeScope` is required: `{ allIncomeInLinkedAccounts: true }`, or `{ allIncomeInLinkedAccounts: false, otherIncomeNgn, otherIncomeNote? }`.
- Every instant (`asOf`, `occurredAt`, `lastSyncedAt`, `coverageFrom`, `openedAt`, gap `from` and `to`) must end in `Z` or a numeric offset like `+01:00`. Without an offset, JavaScript reads the time in the host's timezone, so a New Year's Eve payment could land in a different tax year depending on where the code runs. Every instant is validated field by field (real month and day, leap years, hour 0-23, minute and second 0-59, offset `Z` or up to +/-14:00) and the epoch is computed from those parts, never with `Date.parse`, so `2026-02-30T12:00:00Z` is refused instead of becoming 2 March. Quote dates are plain `YYYY-MM-DD`, checked the same way.
- `estimate(input, rulesOverride?)`: the second argument is for tests only.

Only entries with `kind: "income"`, `direction: "in"` and `occurredAt` inside the tax year count. `own_transfer`, `split_internal`, `cashout` and `refund` are never income. An in-year incoming `other` entry is not ignored: it makes the estimate refuse until the user classifies it. The tax year runs from 1 January 00:00 to 31 December 24:00 in the rules' timezone (Nigeria, +01:00).

### FX quote

`FxQuote = { provider, base, quote: "NGN", date: "YYYY-MM-DD", ngnPerUnit, sourceUrl, retrievedAt }`. `retrievedAt` is an instant with an offset. There is no free-form `source` label.

The statutory quote is checked against `valuation` in the rules: `provider` must be one of `statutoryProviders` (today only `CBN`, Central Bank of Nigeria), `sourceUrl` must start with that provider's `urlPrefix`, `quote` must be `NGN`, the entry's asset must be in `assetBase` and `base` must equal `assetBase[asset]`, `retrievedAt` must be a valid instant not after `asOf`, and `date` must pass the same day rule. The engine cannot prove provenance cryptographically. The quote must come from Caracal's rate adapter, and the engine only checks the provider, pair, date and URL, never a free-form label.

USDC assumption: `assetBase` maps `USDC` to `USD`. USDC income is valued at the CBN official USD/NGN rate on the assumption that 1 USDC = 1 USD (Circle redeems USDC 1:1 for USD). That is an assumption Caracal makes, not a rule in the law (see `assetBaseNote`). Any other asset, such as XLM, refuses: only USDC can be valued today.

The economic (market) quote has the same structure, except `provider` may be any non-empty id and `sourceUrl` any https URL. Its `base` must also match `assetBase[asset]`.

### Output (status "ok")

`grossIncomeNgn`, `reliefs`, `taxableIncomeNgn`, `bands` (each with `ruleId`), `totalTaxNgn`, `effectiveRate`, `incomeLines`, `declaredIncomeLines`, `informational`, `sources`, `disclaimer`.

Every number traces to a rule: bands, reliefs and income lines carry a `ruleId`, and `sources` lists the citation, url and `confidence` of each rule used, so the UI can badge secondary sources.

Each income line has the statutory rate (`ngnPerUnit`) and where it came from: `rateProvider` (the provider's full name), `ratePair`, `rateDate` and `rateSourceUrl`, so the UI never has to invent the word "official". If an economic (market) quote is present and dated the same Lagos day as the payment, the line also has `economicNgnValue`, `fxGapPct` and `economicQuote` (`provider`, `pair`, `date`, `sourceUrl`). If the market quote is from another day, the estimate does not refuse (the market quote does not change tax); the line leaves out `economicNgnValue` and `fxGapPct`, and an `informational` note of kind `fx_gap_omitted` names the entry and the quote date. The gap is (economic - statutory) / statutory, in percent, 2 dp. Positive means the market value is higher than the official value.

Income the user declares through `incomeScope` appears in `declaredIncomeLines` as `{ label, amountNgn, source: "declared by you" }`, is added to gross income, and an `informational` note says it was not verified on chain.

### Rounding

Naira values are decimal strings with 2 dp. Rounding is half up, to the kobo. Each income line (amount times rate) is rounded once, and gross income is the sum of the rounded lines. Each band's tax is rounded once. `effectiveRate` is total tax divided by gross income, as a fraction with 4 dp ("0.1234"), and "0.0000" when there is no income.

## Refusal rules

The result is `{ status: "refused", reasons: [...], disclaimer }` with no numbers when any of these hold:

- The input is not the documented structure: it is not an object, `accounts` or `entries` is not a list, an account, gap or entry is not an object, an account has no non-empty `id` or shares its `id` with another account, an account has no `gaps` list, an entry has no non-empty string `id` or `txHash`, or no `fx` object, or `profile` is not an object. Malformed JSON is refused with a reason, never thrown. An object anywhere in the input with its own `toString` or `valueOf` field is refused, since it could make reading the input throw.
- An in-year income entry has no statutory naira rate, or an invalid amount or rate.
- A statutory quote has a provider not in `statutoryProviders`, a `sourceUrl` outside that provider's `urlPrefix`, a quote currency other than NGN, a `base` that does not match the asset, a `retrievedAt` that is invalid or after `asOf`, a date that is not a real `YYYY-MM-DD`, or a date that fails the rate date rule (see below).
- An in-year income entry's asset is not in `assetBase` (only USDC today).
- `fx.economic` is present (anything other than `null` or missing, including `0`, `""` or `false`) but malformed, has a zero or invalid rate, an empty provider, a non-https `sourceUrl`, a wrong pair, a bad `retrievedAt` or a bad date. A well-formed market quote from another day is not a refusal (see Output). It is never silently dropped.
- A quote's `retrievedAt` is before the start of its own `date` (Lagos calendar day, the rules' `timezoneOffset`). This applies to statutory and economic quotes.
- A quote's `ngnPerUnit` has more than 6 decimal places (`MAX_RATE_DP`), statutory or economic.
- `asOf` is at or after the end of the tax year but an account's `lastSyncedAt` is before the year end: income from the end of the year may be missing.
- `asOf` is before the start of the tax year (the tax year has not started).
- An entry is dated before its account's `openedAt`.
- An entry's `kind` or `direction` is not one of the allowed values (`income`, `own_transfer`, `cashout`, `split_internal`, `refund`, `other`; `in`, `out`). This is checked for every entry before any filtering, and the reason names the entry.
- The rules file names a `valuation.rateDateRule` other than `"same_day"`.
- An account's `lastSyncedAt` is older than `staleAfterHours` (default 24) before `asOf`, or after `asOf`.
- An account's `coverageFrom` is later than the later of the tax year start and its `openedAt`. Being synced today proves nothing about last March.
- An account's chronology is inconsistent: `openedAt` after `asOf`, `coverageFrom` after `asOf`, `lastSyncedAt` before `openedAt`, or `lastSyncedAt` before `coverageFrom`. Each reason names the account and the field.
- An account has a gap that overlaps the tax year, or a gap whose `from` is after its `to`. A gap is `[from, to)`: `to` is the instant history resumes, the same meaning as `coverageFrom`, so a gap that only touches the year at one end, or an empty gap (`from` equal to `to`), does not overlap it.
- Two income entries share the same account, `txHash` (ignoring hex case), asset and amount (compared as numbers, so `10000` and `10000.0` match): they look like the same payment listed twice.
- There are no linked accounts.
- An entry's `accountId` is not one of the linked accounts, or an entry id appears twice.
- An in-year incoming entry has `kind: "other"` (not classified yet).
- `incomeScope` is missing, or says income arrives elsewhere without a valid `otherIncomeNgn`.
- Any instant (including quote `retrievedAt`) has no `Z` or numeric offset, or is not a real date and time.
- An entry is dated after its own account's `lastSyncedAt`: that sync cannot have seen it. The reason names the entry and the account.
- `incomeScope` has `allIncomeInLinkedAccounts: true` together with any other field (`otherIncomeNgn`, `otherIncomeNote`, anything), or has unknown extra keys.
- A naira amount the person typed (`otherIncomeNgn`, `annualRentNgn`) has more than 2 decimal places (`MAX_NAIRA_INPUT_DP`, kobo). It is refused, never rounded.
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
