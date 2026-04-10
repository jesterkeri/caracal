# Caracal

**AI-powered multi-chain tax compliance for Nigerian freelancers, creators, and SMEs — with Stellar as the audit, settlement, and escrow backbone.**

> Built for the [Stellar WA Build Weekend Residency Program](https://bit.ly/stellarwaresidencyguide).
> **Track:** Open & Integration
> **Sprint window:** April 14–18, 2026
> **Status:** 🚧 Pre-sprint. Architecture plan below. Code lands April 14.

---

## The problem

Nigerian freelancers, creators, and SMEs increasingly get paid in stablecoins — USDT on Tron, USDC on Solana, and growing volume on Stellar — by international clients who want to bypass banking friction. But Nigeria's **Tax Act 2025**, effective January 1, 2026, now requires every naira of this income to be tracked, VAT-assessed where applicable, and reported to the Nigeria Revenue Service — with **zero crypto-native compliance tooling** on the market.

Today, Nigerian crypto earners either:

1. Unknowingly evade tax and expose themselves to penalties
2. Overpay by guessing
3. Spend hours manually converting transactions to NGN at fluctuating CBN rates

No existing tool ingests payments from multiple chains, normalizes them to naira at the correct historical rate, and produces an NRS-ready record.

---

## The solution

Caracal is the missing compliance layer:

- **Multi-chain** where users actually receive money — Stellar, Solana, Tron, Ethereum
- **Stellar-native** where it matters most:
  - Immutable **tax receipts** minted on Soroban per taxable event
  - **USDC tax escrow** vaults on Stellar
  - Fiat settlement via Stellar anchors at filing time
- **AI-powered** for the parts humans shouldn't have to handle:
  - Automatic transaction categorization (Claude-powered)
  - **"Ask Caracal"** chat grounded in the full Nigeria Tax Act 2025 with citations
  - Deduction suggestions and compliance nudges
- **Mobile-first** — built for the device Nigerian freelancers actually use. Desktop mode is a progressive enhancement, not the default.

---

## Architecture

```
                          ┌──────────────┐
                          │    Caracal   │
                          └──────────────┘

Ingestion layer (multi-chain):
  Stellar Horizon  →─┐
  Solana Helius    →─┤
  Tron TronGrid    →─┼──→ Normalization service (Node.js)
  ETH Alchemy      →─┘      │
                            │  - polls wallets
                            │  - dedupes txs
                            │  - fetches CBN rate
                            ▼
                      ┌──────────────────┐
                      │    AI layer      │
                      │  Claude API      │
                      │  - classifier    │
                      │  - chat agent    │
                      │  - RAG on NTA    │
                      └────────┬─────────┘
                               ▼
                      ┌──────────────────┐
                      │   Tax engine     │
                      │   NTA 2025 rules │
                      └────────┬─────────┘
                               │
                   ┌───────────┴──────────┐
                   ▼                      ▼
          ┌────────────────┐     ┌──────────────────┐
          │    Stellar     │     │   Postgres DB    │
          │   (Soroban)    │     │   - users        │
          │  - receipts    │     │   - txs          │
          │  - tax vault   │     │   - categories   │
          └────────┬───────┘     └────────┬─────────┘
                   └────────┬─────────────┘
                            ▼
                 ┌────────────────────┐
                 │  Next.js frontend  │
                 │  (mobile-first)    │
                 │  - dashboard       │
                 │  - chat UI         │
                 │  - PDF export      │
                 └────────────────────┘
```

---

## Core features

| # | Feature | What it does |
|---|---|---|
| F1 | **Multi-chain ingestion** | Connect a read-only wallet on Stellar, Solana, Tron, or Ethereum and pull all incoming stablecoin payments |
| F2 | **NGN normalization** | Convert every transaction to NGN using the CBN rate on the transaction date |
| F3 | **AI categorization** | Claude auto-classifies each payment (client work, refund, transfer, etc.) with manual override |
| F4 | **Nigeria Tax Act 2025 engine** | Live PIT, VAT, and withholding calculations under the new Act |
| F5 | **Soroban tax receipts** | Non-transferable on-chain receipt minted per taxable event — instant auditability |
| F6 | **USDC tax escrow** | Optional Stellar-based vault that locks tax liability until filing |
| F7 | **"Ask Caracal" chat** | RAG-powered assistant grounded in the Nigeria Tax Act 2025 with source citations |
| F8 | **NRS-ready PDF export** | Filing-ready summary with embedded Stellar tx hash audit trail |

---

## Why Stellar

- **Low fees enable on-chain audit trails.** Minting a compliance receipt per transaction costs ~$0.001 on Stellar vs ~$5 on Ethereum mainnet. Caracal's core primitive is economically impossible on any other L1.
- **Anchors enable fiat settlement.** Stellar's anchor model lets us convert USDC → NGN for tax remittance without leaving the protocol.
- **Soroban fits the use case.** Non-transferable tax receipts are logic-light and audit-heavy — exactly Soroban's sweet spot.
- **West Africa alignment.** Stellar's anchor network in the region (USDC, NGNC, MoneyGram) is already the strongest of any chain. Caracal is building for where Stellar's West African rails are strongest.

---

## Tech stack

- **Frontend:** Next.js 14 (App Router), TailwindCSS, shadcn/ui — **mobile-first responsive**, PWA-ready
- **Backend:** Next.js API routes, Prisma + Postgres (Supabase)
- **Blockchain:**
  - Stellar: Horizon API + `@stellar/stellar-sdk`, Soroban (Rust) for contracts
  - Solana: Helius API
  - Tron: TronGrid
  - Ethereum: Alchemy
- **AI:** Anthropic Claude API — Sonnet for chat, Haiku for bulk classification
- **RAG:** Supabase pgvector over the chunked Nigeria Tax Act 2025
- **FX rates:** CBN API with CoinGecko fallback
- **PDF:** react-pdf
- **Auth:** Clerk
- **Deploy:** Vercel (frontend + API), Stellar testnet for contracts

---

## 5-day sprint schedule (April 14–18)

| Day | Focus | Deliverable |
|---|---|---|
| **Mon Apr 14** | Foundations | Stellar testnet wallet connected, incoming txs with NGN values in a basic mobile UI |
| **Tue Apr 15** | Multi-chain + AI categorization | 4 chains ingesting, unified timeline, Claude-classified categories |
| **Wed Apr 16** | Tax engine + Soroban contract | Live tax liability dashboard; every taxable event mints a Soroban receipt |
| **Thu Apr 17** | AI chat + PDF export | "Ask Caracal" chat grounded in NTA 2025; NRS-style PDF export |
| **Fri Apr 18** | Polish + demo + submit | Bugfix, polish, demo video, pitch deck, submission |

---

## 30-day deliverable (if selected for the residency)

By Day 30 of funding:

1. **Live beta** with 50 real Nigerian freelancer users recruited via Twitter/X and Discord
2. **Multi-chain ingestion** battle-tested on Stellar, Solana, Tron, and Ethereum mainnet
3. **Soroban tax receipt contract** externally reviewed by one security reviewer
4. **USDC tax escrow** live on Stellar mainnet with at least one real deposit
5. **NRS-compliant PDF export** validated by at least one practicing Nigerian accountant
6. **Mono integration** for Nigerian bank account sync
7. **"Ask Caracal" agent** trained on the full Nigeria Tax Act 2025 with citations
8. **First 10 beta users** complete a tax filing using Caracal-generated data

---

## About the builder

**Joshua Zekeri** — Full-stack + smart contract developer based in Lagos, Nigeria. Solo applicant under **Lucky Roo**.

**Previously shipped**
- **GiveRep (v1)** — built the first version of GiveRep, a Web3 reputation platform
- **krill.tube** — production build, shipped and live

**Currently building**
- **Cuttlefish**, **Krait**, **Buddies**, and now **Caracal**

**Links**
- GitHub: [@jesterkeri](https://github.com/jesterkeri/)
- Portfolio: [joshuazekeriportfolio.xyz](https://joshuazekeriportfolio.xyz)

I write full-stack code and smart contracts, and I ship. I'm new to Stellar/Soroban specifically, but my smart contract experience on other chains transfers directly. As a Lagos-based developer who receives crypto payments myself, **I am Caracal's target user.**

---

## Status

🚧 **Pre-sprint.** This repo currently contains the problem statement, architecture, and sprint plan. Code lands April 14, 2026 when the Stellar WA Virtual Build Sprint begins.

## License

MIT — to be added with the first code commit.
