# Fix day: Sunday 29 November 2026

This day is for issues that do not move money, and for testing the whole user
journey. Money paths (wallet authorization, relay, contracts, payments,
withdrawals, cash-out, and the tax calculation and refusal logic) are fixed
when they are found, not saved for this day.

## Queued non-money issues

| Found | Where | Issue | Proof |
|---|---|---|---|
| Receipt adversary round 4 | `apps/web/src/lib/stellar/receipt.ts` (`isNetworkError`) | An RPC answer cut off partway, or an empty 200 body, says "could not read this transaction's details" instead of "could not reach the network" | Test `adversary-rcpt4-truncated.test.ts`, kept for this day |
| Receipt adversary round 4 | `apps/web/src/lib/relay/sponsor.ts` (`within`), called from `receipt-body.tsx` | After the 20 s limit the page stops waiting, but its request to the RPC is never cancelled | Test `adversary-rcpt4-hang.test.ts`, kept for this day |
| Receipt adversary round 4 (suspicion) | `refText` | A UTF-8 invoice reference such as "Café-1" is shown as hex, but the decisions row says only a non-text reference is | Not proven |
| Receipt adversary round 4 (suspicion) | Receipt card | A long invoice reference with no breaks may overflow a narrow card | Not proven, cosmetic |
| Receipt adversary round 4 (suspicion) | Receipt page | No rate limit or caching in front of the RPC call | Not proven |

## User pipeline testing

Each journey is run in a real browser on testnet, with its result written
down here.

1. Sign in with Google, create a passkey wallet, sign out, sign back in, and
   check that the same wallet is restored.
2. Deploy the split contract from the app.
3. Create an invoice and copy its pay link.
4. Pay the invoice from a second account in USDC, then open the receipt.
5. Read the naira tax estimate, which must show its source and "estimate, not
   tax advice".
6. Cash-out preview, then a SEP-24 cash-out on testnet.
7. Failure paths:
   - offline in the middle of a step;
   - a second tab signing in with another account;
   - a cancelled passkey prompt;
   - an unfunded account.

Joshua runs the steps that need Google sign-in and a real passkey, on his
phone and on a laptop. I script whatever a headless browser can reach.
