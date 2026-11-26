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
2. **Send an invoice.** The client gets a pay link and pays the invoice straight into Ada's split contract in USDC, in one signature. A client holding only XLM first converts it to the exact USDC amount on the Stellar DEX (a second signature).
3. **The split happens on chain, in the same transaction as the payment.** A Soroban contract that only Ada controls sorts the payment into a tax pot, a savings goal and spendable money, and records the invoice it paid.
4. **Prepare for tax, in naira, with the law shown.** Every payment is valued in naira on the day it arrived. The estimate names the rule and source behind each line, and it refuses to show a number when data is missing or stale. Caracal prepares records for Ada and her accountant. It does not file returns or pay tax.
5. **Safe to spend.** One naira number: the spendable pot minus the rent and bills building up that it does not already cover. The tax and goal pots are already set aside, so they are not subtracted twice. Tap it to see the formula.
6. **Cash out** through a Stellar anchor (SEP-24). On testnet this uses the SDF test anchor, which is a simulated withdrawal, not naira reaching a bank. A live naira payout needs a licensed anchor partner. Caracal shows a sourced note on stamp duty and deducts nothing for it.

Caracal never holds user funds or keys. It is an estimate tool, not a tax adviser.

## Stellar depth

| Step | Stellar feature | Status |
|---|---|---|
| Sign-up | Passkey smart wallet: a Soroban smart account via `smart-account-kit` and OpenZeppelin smart accounts | **live** (spike page `/wallet`), e.g. [wallet](https://stellar.expert/explorer/testnet/contract/CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX) |
| No XLM needed | Fee sponsorship: our `/api/relay` server route forwards to SDF's testnet relayer proxy, which fee-bumps through OpenZeppelin Channels | **live**: [deploy tx](https://stellar.expert/explorer/testnet/tx/77975e3e1a03c93603a03515566dc984eb22668336b7a60a6916163bcd9cf727), fee paid by the sponsor |
| Client pays | Direct USDC `deposit` into the split contract; for XLM, a classic `path_payment_strict_receive` on the Stellar DEX first (XLM in, exact USDC out) | planned |
| Payment arrives | Soroban split contract, one per user, emitting a `split` event per payment | **live** on testnet: [contract](https://stellar.expert/explorer/testnet/contract/CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M), [invoice](https://stellar.expert/explorer/testnet/tx/bc24a22ffcc4d69fe8b0d4538157df16f22c7b4f8f7db3bfa599aa7b94d633a3), [payment](https://stellar.expert/explorer/testnet/tx/7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb) |
| Invoice match | The owner opens each invoice on chain with its exact amount. A payment must quote the invoice and pay exactly that amount, once, so nobody can block an invoice by paying 1 stroop first | **live** in the contract; app side planned |
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

| Action | Who |
|---|---|
| Sign for the wallet | The user's passkey only |
| Withdraw or move money between pots | The user (owner) only |
| Change the split | The user only |
| Open or cancel an invoice | The user (owner) only |
| Pay an invoice into the contract | Anyone, with their own funds and their own signature, for exactly the invoiced amount |
| Upgrade or pause the contract | Nobody: there is no admin and no upgrade function |
| Pay network fees | The fee sponsor (OpenZeppelin Channels). It can pay fees and nothing else. Caracal's `/api/relay` only passes on passkey wallet deploys, split contract calls and USDC transfers, where every payer, owner and signer is a Caracal passkey wallet and every contract that runs is Caracal's (split over USDC, official WebAuthn verifier). The relay builds each transaction itself, simulates it with every signature enforced, refuses any wasm in its footprint that is not Caracal's, and signs it with a relay-only testnet account; the sponsor only adds the fee bump, so a wallet upgraded after the check cannot run new code in a sponsored transaction. Per-instance rate limits |
| Read the ledger | Caracal's indexer, rebuilt from the public chain at any time |
| Hold funds during a cash-out | The anchor, for the length of its own withdrawal process |

Google sign-in identifies the account in the app. It cannot sign transactions or recover the wallet. The full contract rules are in `contracts/split/README.md`.

## Run it

Requirements: Node 22+, pnpm 10 (`corepack pnpm@10.32.1`), Rust with the `wasm32v1-none` target, Stellar CLI 30.

```
corepack pnpm@10.32.1 install
corepack pnpm@10.32.1 test
cd contracts/split && cargo test
```

```
corepack pnpm@10.32.1 -C apps/web dev     # http://localhost:3000/wallet
```

Environment variables are optional on testnet; see `apps/web/.env.example`. Leave them commented out to use the defaults.

## Tax figures and their sources

The 2026 rules live in `packages/tax/rules/NG/2026.json`, and every rule carries its citation. The figures were checked on 25 November 2026 against Big-4 summaries (PwC, KPMG) of the Nigeria Tax Act 2025 and NRS Information Circular 2026/21. The primary texts could not yet be fetched, so the app labels these figures as secondary sources. Withholding tax on professional fees paid in crypto is not modelled, because no source gives its rate.

## Not done yet

- Everything marked "building" or "planned" above.
- Proof of income statement, Tax ID registration help, filing reminders and full runway forecasting are roadmap items.
- Bank linking, cards and mainnet are out of scope for the Buildathon.
