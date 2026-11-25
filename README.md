# Caracal

**A smart wallet for Nigerian freelancers paid from abroad. It runs on Stellar, and only the freelancer holds the keys.**

Built for the Stellar Buildathon 2026 (Nigeria chapter). Testnet only.

> Status: build week, 25 to 30 November 2026. This README tracks what is real. Anything not marked **live** is still being built.

## The problem

Ada is a designer in Lagos with a client in London. She gets paid in dollars, but her rent, bills and tax are in naira. Since 1 January 2026, the Nigeria Tax Act 2025 and NRS guidance on virtual assets say income received in crypto is taxable at its naira value. She has no tool that tells her:

- how much of this payment is not really hers, because it is owed as tax,
- what she can safely spend this month once rent and her savings goal are covered,
- how to turn dollars into naira without handing her money to someone else.

So she guesses. She over-spends in a good month, and the tax bill or the yearly rent arrives as a shock.

## What Caracal does

1. **Sign up with Google and a fingerprint.** Caracal creates a passkey smart wallet on Stellar. There is no seed phrase and no XLM to buy, because Caracal sponsors network fees.
2. **Send an invoice.** The client gets a pay link. They can pay in XLM or another Stellar asset, and Ada receives an exact amount of USDC.
3. **The split happens on chain.** A Soroban contract that only Ada controls sorts each payment into a tax pot, a savings goal and spendable money.
4. **Tax in naira, with the law shown.** Every payment is valued in naira on the day it arrived. The estimate names the rule and source behind each line, and it refuses to show a number when data is missing or stale.
5. **Safe to spend.** One naira number: spendable money minus rent and bills that are building up minus goal money. Tap it to see the formula.
6. **Cash out to naira** through a Stellar anchor, with the 1.5% stamp duty shown before Ada confirms.

Caracal never holds user funds or keys. It is an estimate tool, not a tax adviser.

## Stellar depth

| Step | Stellar feature | Status |
|---|---|---|
| Sign-up | Passkey smart wallet: a Soroban smart account via `smart-account-kit` and OpenZeppelin smart accounts | building |
| No XLM needed | Fee sponsorship through the OpenZeppelin Channels relayer (fee bump), called only from our server | building |
| Client pays | Classic `path_payment_strict_receive` on the Stellar DEX (XLM in, exact USDC out) | planned |
| Payment arrives | Soroban split contract, one per user, emitting a `split` event per payment | building |
| Invoice match | Invoice reference passed into the contract and emitted in its event | building |
| Ledger | Horizon payments and Soroban events indexed into Postgres; the tax engine reads this | planned |
| Cash-out | SEP-24 interactive withdraw with SEP-45 (or SEP-10) auth on the SDF test anchor | planned |
| Naira value | Oracle-shaped rate interface. Reflector has no NGN feed, so the CBN official rate is used and labelled | planned |
| Bonus | Claimable balances, CCTP inbound USDC | only if time allows |

Details and sources for every choice are in [docs/research/verify-2026-11-25.md](docs/research/verify-2026-11-25.md).

## Repo layout

| Path | What |
|---|---|
| `apps/web` | Next.js app, mobile first |
| `contracts/split` | Soroban split contract (Rust) |
| `packages/tax` | Tax engine: pure TypeScript, rules as data versioned by tax year |
| `packages/stellar` | Shared Stellar helpers |
| `docs/` | Research, architecture, demo script |
| `docs/archive/` | The April 2026 read-only plan this project grew from |

## Who can move money

Only the wallet owner. The split contract has no admin and no upgrade function. The fee sponsor can pay network fees and nothing else. The full contract rules are in `contracts/split/README.md`.

## Run it

Requirements: Node 22+, pnpm 10 (`corepack pnpm@10.32.1`), Rust with the `wasm32v1-none` target, Stellar CLI 30.

```
corepack pnpm@10.32.1 install
corepack pnpm@10.32.1 test
cd contracts/split && cargo test
```

App setup and environment variables will be documented when `apps/web` lands.

## Tax figures and their sources

The 2026 rules live in `packages/tax/rules/NG/2026.json`, and every rule carries its citation. The figures were checked on 25 November 2026 against Big-4 summaries (PwC, KPMG) of the Nigeria Tax Act 2025 and NRS Information Circular 2026/21. The primary texts could not yet be fetched, so the app labels these figures as secondary sources. Withholding tax on professional fees paid in crypto is not modelled, because no source gives its rate.

## Not done yet

- Everything marked "building" or "planned" above.
- Proof of income statement, Tax ID registration help, filing reminders and full runway forecasting are roadmap items.
- Bank linking, cards and mainnet are out of scope for the Buildathon.
