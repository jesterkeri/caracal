# Fix day: Sunday 29 November 2026

This day is for issues that do not move money, and for testing the whole user
journey. Money paths (wallet authorization, relay, contracts, payments,
withdrawals, cash-out, and the tax calculation and refusal logic) are fixed
when they are found, not saved for this day.

## Queued non-money issues

Codex R6 (27 Nov) says two of these must be decided before any public deployment, even on testnet: the shared sponsor quota (the `/api/relay` per-process limits are burst controls, not a budget) and the callback `Cache-Control: no-store` (`apps/web/src/lib/supabase/server.ts`). Joshua decides; nothing deploys before that.

| Found | Where | Issue | Proof |
|---|---|---|---|
| Receipt adversary round 4 | `apps/web/src/lib/stellar/receipt.ts` (`isNetworkError`) | An RPC answer cut off partway, or an empty 200 body, says "could not read this transaction's details" instead of "could not reach the network" | Test `adversary-rcpt4-truncated.test.ts`, kept for this day |
| Receipt adversary round 4 | `apps/web/src/lib/relay/sponsor.ts` (`within`), called from `receipt-body.tsx` | After the 20 s limit the page stops waiting, but its request to the RPC is never cancelled | Test `adversary-rcpt4-hang.test.ts`, kept for this day |
| Receipt adversary round 4 (suspicion) | `refText` | A UTF-8 invoice reference such as "Café-1" is shown as hex, but the decisions row says only a non-text reference is | Not proven |
| Receipt adversary round 4 (suspicion) | Receipt card | A long invoice reference with no breaks may overflow a narrow card | Not proven, cosmetic |
| Receipt adversary round 4 (suspicion) | Receipt page | No rate limit or caching in front of the RPC call | Not proven |
| Day 1 adversary r4e (suspicion) | `apps/web/src/app/signin/page.tsx` | Coming Back from Google may restore the page from the browser's back/forward cache with "Opening Google..." still disabled (no `pageshow` handler) | Not proven; check in a real browser |
| Day 1 adversary r4e (suspicion), corrected by Codex R5 | `/api/relay` | There are per-IP and per-instance limits, but they are per process, not a shared sponsor budget (accepted for testnet). Decide on a shared quota before a public deploy | Not proven |
| Codex tax R4 #2 | `/tax/estimate` | The route now has a 100 s deadline that aborts its network reads, passes on the caller going away, and has per-process limits (6 a minute per client address, 60 a minute per process). Like the relay's, those limits are per process, not a quota shared across server instances. Decide on a shared quota (with the database) before a public deploy | Deployment prerequisite |
| Adversary t17 (suspicions) | `/tax/estimate` | The route sets no `maxDuration`: a hosting platform whose default function limit is under the route's 100 s deadline would cut it off first, and the page would say to check the connection. The body read (`readBounded`) has no deadline of its own (as with the relay, it relies on the platform). An instance-level refusal still uses up the caller's per-client count | Check at deploy |
| Day 1 adversary r4d (suspicion) | `apps/web/src/app/wallet/page.tsx` | After "not-saved" (the session could not be confirmed when binding), the page still says "Signed in as ..." | Not proven |
| Day 1 adversary r4h (suspicion) | `apps/web/src/app/signin/page.tsx` | After a successful Sign out here, the account follower still expects the old account, so signing in again as the same account in another tab is not picked up until a reload | Not proven |
| Day 1 adversary r4i (suspicion) | `apps/web/src/lib/supabase/deadline.ts` | The 10 s deadline could abort a token refresh whose answer (a rotated refresh token) was already on its way. Supabase allows reuse of the parent token for a short interval, so a retry should recover; check against the project's settings | Not proven |
| Day 1 adversary r4k (suspicion) | `apps/web/src/app/route.ts` | A sign-in return at the site root with `?code=` and an `error_code` but no `error` is forwarded to the callback, which drops the upstream error | Not proven |
| Day 1 adversary r4l (suspicion) | `apps/web/src/app/wallet/page.tsx` | Connect and Create have no limit after the passkey step, so an RPC that accepts the connection and never answers leaves "busy" until a reload (the kit's own relayer wait is up to 360 s) | Not proven |
| Day 1 adversary r4l (suspicion) | `apps/web/src/lib/relay/channels.ts` | A Channels 429 that comes with a body loses its status, so the person reads "check your activity" instead of "busy" | Not proven |
| Day 1 adversary r4n (suspicion) | `apps/web/src/app/wallet/page.tsx` | During the first sign-in check (up to about 60 s when Supabase is unreachable) the wallet page shows no Sign out; the sign-in page does | Not proven |
| Day 1 adversary r4n (suspicion) | `apps/web/src/lib/supabase/server.ts` | The callback's `setAll` ignores the `Cache-Control: no-store` that @supabase/ssr passes with auth cookies | Not proven; check before the deploy |
| Day 1 adversary r4p (suspicion) | `/api/relay` policy lookups | One request can make up to about 80 sequential RPC lookups (20 s each) before the queue, and unknown contract ids are not cached; the per-IP limit bounds it. Part of the queue-deadline decision before the deploy | Not proven |
| Day 1 adversary r4r (suspicion) | `apps/web/src/app/wallet/page.tsx` (`storageBlocked`) | smart-account-kit's IndexedDB storage can fail with "Failed to get session: ..." or "Failed to save session: ..." without naming IndexedDB, so blocked storage may be shown as "check your connection" | Not proven |
| Day 1 adversary r4r (suspicion) | `apps/web/src/app/wallet/page.tsx` (`connect`, `create`) | `getKit()` has no time limit there, so a stalled first load of the kit leaves the busy label until Sign out or a reload (close to the r4l suspicion) | Not proven |
| Day 1 adversary r4r (suspicion) | `apps/web/src/app/wallet/page.tsx` | A new account that presses "I already have a wallet" and finds none loses Create until a reload (deliberate since r4i), and nothing on screen says to reload | Not proven; a copy question |
| Day 1 adversary r5a (suspicion) | `apps/web/src/app/wallet/page.tsx` | A sign-in as another account completed in another tab by the server callback (cookies) may fire no auth event in this tab, which keeps showing the earlier account's wallet until a reload (binding re-checks the account first) | Not proven; check in a real browser |
| Adversaries i6, s6 (suspicion) | `apps/web/src/lib/relay/channels.ts` (`REFUSED_BEFORE_SUBMIT`) | Channels codes not in the list (FAILED_TO_GET_SEQUENCE, SIMULATION_RPC_FAILURE, RELAYER_UNAVAILABLE, CONFIG_MISSING, CONFIG_INVALID, KV_ERROR and others) read as "could not confirm", though some may be raised before sending. Errs towards caution; each needs the plugin 0.21.1 source traced before it is added | Not proven |
| Adversary c5 (follow-up) | `apps/web/src/lib/invoices/chain.ts`, `apps/web/src/lib/split/send.ts` | The kit's pre-send contract error (code 10000 with no hash) is now "not sent" on cash-out only; invoices and split still say "may have gone through" for it (cautious, not false) | Proven on cash-out (adversary-c5-kit-resim-contract-error) |

Promoted out of this list by Codex R5 and fixed on 27 Nov (decisions rows of that date): the r4h hint after signing in again, the r4l relay queue deadline, and the r4q "no wallet" judged on the ledger endpoint alone.

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
