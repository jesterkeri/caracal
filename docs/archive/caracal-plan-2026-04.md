# Caracal — Project Plan (v0.1)

**Track:** Open & Integration
**Team:** Lucky Roo (Joshua Zekeri, solo)
**Built for:** Stellar WA Build Weekend Residency Program
**Last updated:** April 10, 2026

---

## 1. One-sentence pitch

Caracal is an AI-powered multi-chain tax compliance platform that helps Nigerian freelancers, creators, and SMEs track stablecoin income, compute their naira-denominated tax liability under the Nigeria Tax Act 2025, and generate NRS-ready tax records — with Stellar as the audit, settlement, and escrow backbone.

---

## 2. Users

- **Primary:** Nigerian freelancers and creators earning $500–$10,000/month in stablecoins (USDT, USDC) from international clients on Upwork, Fiverr, Deel, direct contracts, etc.
- **Secondary:** Nigerian SMEs accepting stablecoin payments who need FIRS/NRS-compliant records.
- **Tertiary:** Crypto traders and diaspora remitters with Nigerian tax obligations.

---

## 3. Core features (5-day sprint MVP)

### F1. Multi-chain wallet ingestion
- Connect a read-only public address (Stellar, Solana, Tron, Ethereum)
- Pull all incoming stablecoin transactions (USDT, USDC)
- Display a unified timeline across chains

### F2. NGN normalization
- For each transaction, fetch CBN exchange rate on the transaction date
- Persist NGN-denominated value alongside on-chain data
- Immutable historical record — no backfill drift

### F3. AI-powered transaction categorization
- Claude classifies each incoming payment: client work (income), refund, internal transfer, gift, loan repayment, token sale
- User can override; corrections feed back into category confidence
- Natural-language tagging ("this was from my Upwork client John")

### F4. Nigeria Tax Act 2025 engine
- PIT bands, VAT thresholds, withholding rules, expatriate-income treatment
- Live running totals: "You owe ₦X in PIT year-to-date, ₦Y in VAT this quarter"
- Deduction hints (allowable expenses under the Act)

### F5. Stellar-native compliance layer (the novel bit)
- **Soroban smart contract** mints a non-transferable "tax receipt" token per taxable event — immutable audit trail, verifiable by an NRS auditor in seconds
- **USDC tax escrow contract** on Stellar — users can optionally auto-lock tax liability in a Stellar USDC vault until filing date
- All tax records reference Stellar transaction hashes as proof-of-record

### F6. "Ask Caracal" AI chat assistant
- Chat interface for tax questions
- **RAG** over the Nigeria Tax Act 2025 (and supporting NRS guidance)
- Grounded answers with citations to specific Act sections — no hallucinated tax law
- Explains calculations, suggests deductions, flags compliance risks

### F7. NRS-ready export
- PDF tax summary formatted for direct filing
- Embedded Stellar transaction hash audit trail
- Share-link version for accountants

---

## 4. Architecture

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
                 │   Next.js frontend │
                 │   - dashboard      │
                 │   - chat UI        │
                 │   - PDF export     │
                 └────────────────────┘
```

---

## 5. Tech stack

- **Frontend:** Next.js 14 (App Router), TailwindCSS, shadcn/ui — **mobile-first responsive web** (desktop mode as a progressive enhancement)
- **Backend:** Next.js API routes or tRPC, Prisma + Postgres (Supabase for speed)
- **Blockchain:**
  - Stellar: Horizon API + `@stellar/stellar-sdk` (JS) for read, Soroban Rust for contracts
  - Solana: Helius API
  - Tron: TronGrid
  - Ethereum: Alchemy
- **AI:** Anthropic Claude API — Sonnet for chat and categorization, Haiku for bulk classification
- **RAG:** Supabase pgvector over chunked Nigeria Tax Act 2025
- **FX rates:** CBN API with CoinGecko fallback
- **PDF:** react-pdf
- **Auth:** Clerk (email + Google)
- **Deploy:** Vercel (frontend + API), Stellar testnet for contracts

---

## 6. 5-day sprint schedule (April 14–18)

### Day 1 — Mon Apr 14: Foundations
- Project scaffold (Next.js + Tailwind + shadcn + Prisma)
- DB schema: Users, Wallets, Transactions, Categories, TaxReceipts
- Stellar Horizon integration — pull incoming txs for a test wallet
- CBN rate API wrapper with CoinGecko fallback
- **Deliverable:** Connect a Stellar testnet wallet, see payments with NGN values in a basic table

### Day 2 — Tue Apr 15: Multi-chain + AI categorization
- Solana + Tron + Ethereum ingestion adapters
- Unified transaction schema
- Claude API integration for auto-categorization
- Manual override UI
- **Deliverable:** Connect wallets from 4 chains, unified timeline, AI-classified categories

### Day 3 — Wed Apr 16: Tax engine + Soroban contract
- Nigeria Tax Act 2025 rule set (PIT bands, VAT, withholding)
- Live tax liability dashboard
- Soroban contract: mint non-transferable tax receipt per taxable event
- Deploy to Stellar testnet
- **Deliverable:** Dashboard shows live tax liability; every taxable event mints a Soroban receipt

### Day 4 — Thu Apr 17: AI chat + PDF export
- Chat UI (streaming, context-aware)
- RAG setup over Nigeria Tax Act 2025 (pgvector)
- "Ask Caracal" agent answers grounded in the Act with citations
- PDF export — NRS-style tax summary with Stellar tx hash audit trail
- **Deliverable:** Working chat, exportable tax report

### Day 5 — Fri Apr 18: Polish, demo, submit
- Bug fixing, UI polish
- Record demo video (<3 min, happy-path walkthrough)
- Finalize pitch deck
- Submit repo + deck + demo video
- **Deliverable:** Everything submitted before deadline

---

## 7. Out of scope for sprint MVP

- Production-grade auth flows (Clerk defaults only)
- Real NRS API integration (mock the export format)
- USDC escrow live on mainnet (testnet demo only)
- Bank account sync (Mono/Okra) — Day 30 target
- Native iOS/Android apps (web is mobile-first responsive, PWA-ready)
- Full history backfill (last 90 days only)

---

## 8. 30-day deliverable (what ships if residency wins)

By Day 30 of funding:

1. **Live beta** with 50 real Nigerian freelancer users recruited via Twitter/X and Discord
2. **Multi-chain ingestion** battle-tested on Stellar, Solana, Tron, and Ethereum mainnet
3. **Soroban tax receipt contract** externally reviewed by one security reviewer
4. **USDC tax escrow** live on Stellar mainnet with at least one real deposit
5. **NRS-compliant PDF export** validated by at least one practicing Nigerian accountant
6. **Mono integration** for Nigerian bank account sync (USD/NGN balances + settlements)
7. **"Ask Caracal" agent** trained on the full Nigeria Tax Act 2025 with source citations
8. **First 10 beta users** complete a tax filing using Caracal-generated data

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| New to Stellar/Soroban | Pre-study Horizon + Soroban docs before April 14; complete Soroban quickstart this weekend |
| AI hallucination on tax advice | RAG grounded in the official Act; every answer shows source citations; disclaimer on non-deterministic outputs |
| CBN rate API reliability | CoinGecko and cached rate table fallbacks |
| 5 days is tight | Pre-work this weekend: scaffolding, env, wallet connect flows |
| Judges unfamiliar with Nigerian tax | Demo leads with user story, not regulations |

---

## 10. Why Stellar

- **Low fees enable on-chain audit trails.** Minting a compliance receipt per transaction costs ~$0.001 on Stellar vs ~$5 on Ethereum mainnet. Caracal's core primitive is economically impossible on any other L1.
- **Anchors enable fiat settlement.** Stellar's anchor model lets us convert USDC → NGN for tax remittance without leaving the protocol.
- **Soroban fits the use case.** Non-transferable tax receipts are logic-light, audit-heavy — exactly Soroban's sweet spot.
- **West Africa alignment.** Stellar's anchor network in the region (USDC, NGNC, MoneyGram) is already the strongest of any chain. Caracal is building for where Stellar's West African rails are strongest.

---

## 11. Success metrics for sprint submission

- ✅ Multi-chain wallet connect working for at least 2 chains (Stellar + Solana minimum)
- ✅ Soroban tax receipt contract deployed and minting on testnet
- ✅ AI chat answers at least 5 sample tax questions with correct Act citations
- ✅ PDF export renders cleanly
- ✅ Demo video <3 minutes, clearly shows the happy path
- ✅ Pitch deck tells the story in 10 slides or fewer
