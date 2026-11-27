# SEP-45 + SEP-24 cash-out spike on the SDF test anchor (2026-11-27)

Everything below was run live against `testanchor.stellar.org` and public Stellar testnet with a throwaway wallet. The passkey was a software P-256 key signing through smart-account-kit 0.10.0's own `signAuthEntry`. Script: `apps/web/scripts/live-anchor-spike.mjs` (steps `wallet`, `usdc`, `withdraw`, `status`; shared helpers in `live-anchor-common.mjs`). Keys live in a scratch file outside the repo.

## Verdict

The full path works: SEP-45 sign-in for a C-address passkey wallet, SEP-24 interactive withdraw of USDC, the wallet's USDC payment to the anchor with the memo carried in a muxed (M) destination, and the anchor marking the withdrawal complete. SEP-10 is not needed.

## 1. SEP-45 (works)

- `stellar.toml` lists `WEB_AUTH_FOR_CONTRACTS_ENDPOINT = https://testanchor.stellar.org/sep45/auth`, `WEB_AUTH_CONTRACT_ID = CD3LA6RK...GQXMX`, `SIGNING_KEY = GCHLHDBO...W233PR`, `TRANSFER_SERVER_SEP0024 = https://testanchor.stellar.org/sep24`.
- `GET /sep45/auth?account=C...&home_domain=testanchor.stellar.org` returns `{authorization_entries, network_passphrase}`. The entries are a base64 XDR array of two `web_auth_verify` calls on the web auth contract, each with one map argument `{account, home_domain, nonce, web_auth_domain, web_auth_domain_account}`, no sub-calls. The first entry is the wallet's (signature void, expiry ledger 0). The second is the anchor's, already signed by `SIGNING_KEY`.
- The wallet signs its own entry with `kit.signAuthEntry(entry, { expiration, contextRuleIds: [0] })`. The kit requires `contextRuleIds`; rule 0 is the default rule a Caracal wallet is created with. Expiry is set by the caller (latest ledger + 100 here).
- `POST /sep45/auth` with `{authorization_entries: <base64 of the array>}` returns `{token}`. The array is encoded by hand (4-byte big-endian count, then each entry), because the SDK's array type would not encode it. The anchor verifies by simulating `web_auth_verify`, which calls the wallet's `__check_auth`, so the wallet must already be deployed.
- Browser CORS works: the anchor echoes `Access-Control-Allow-Origin` for `http://localhost:3000` on the SEP-45 and SEP-24 POSTs, and `*` on toml, info and transaction. No Caracal server route is needed; the token lives in page memory only.

## 2. SEP-24 withdraw (works)

- `GET /sep24/info`: USDC withdraw enabled, min 1, max 10. `fee.enabled` is false and no `fee_fixed` or `fee_percent` is published, so the preview cannot compute the fee in advance. The anchor quotes it after the interactive step: on 2 USDC it quoted `fee_details.total = 0.2` and `amount_out = 1.8` (10%).
- `POST /sep24/transactions/withdraw/interactive` takes **JSON** (form-encoded is refused with 500 "Content-Type ... is not supported"), body `{asset_code:"USDC", account:"C...", amount, lang}`, header `Authorization: Bearer <SEP-45 token>`. It answers `{type:"interactive_customer_info_needed", url, id}`. A C-address account is accepted.
- The form is `https://anchor-ref-ui-testanchor.stellar.org?transaction_id=...&token=...` (a different host from the anchor, and its own short-lived token). That UI answers `X-Frame-Options: DENY`, so **an iframe is impossible; a popup is required**. It does not call `postMessage` on the opener, so the page learns the form is done by polling.
- The form collects name, surname, email, bank and account, then the withdrawal moves from `incomplete` to `pending_user_transfer_start` with `withdraw_anchor_account` (a classic G account), `withdraw_memo` (a uint64 as text) and `withdraw_memo_type = "id"`. A script drives the same UI API (`POST https://anchor-reference-server-testanchor.stellar.org/start`, then `/submit`); the page opens the real form in a popup instead.

## 3. How the funds reach the anchor (muxed destination)

Soroban transactions carry no memo. The anchor's memo is an `id`, so it goes inside a muxed address: `MuxedAccount(anchorG, memoId).accountId()` gives an `M...` address. The USDC SAC `transfer(from, to, amount)` accepts a muxed `to` (CAP-67), and the anchor read the id back and matched the payment. A text or hash memo cannot be carried this way (the page refuses it before signing).

The wallet authorises the direct USDC `transfer(wallet, M..., amount)` (the same shape the kit builds for `kit.transfer`, which refuses an M address, so the page builds the host function itself and calls `kit.signAndSubmit`). Caracal's relay policy does not inspect `to`, so a wallet-to-muxed USDC transfer is sponsored as is (`test/anchor-transfer.test.ts` runs `checkPayload` on exactly this shape). No policy change is needed.

## 4. Live run, tx ids

| Item | Value |
|---|---|
| Throwaway wallet (C) | `CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW` |
| Wallet deploy tx | `053189f0a6b2c68c838943b6bebead65b59b66fa6b1fd57995d2e383f56a6e86` |
| USDC bought on the DEX | swap tx `8eff99056aac914d03b2badec12823757ed9b67636ec345076c3817e69a7d86d` |
| Moved 9 USDC into the wallet | `1af624cbcb0c7667f619584401de86092eb7c7ea629b2743e490c697f1d14cde` |
| Anchor transaction | `147a673a-618d-48f5-812e-f9828525d9b0` |
| Wallet's USDC payment to the anchor (2 USDC to `MBN4NNCD...`, memo id 6604750969419921559) | `cb718a8337e23939e52d3c5f4588e000b23ed2f3614a16fca4838889510f6b6d` |
| Anchor record | `pending_user_transfer_start` -> `pending_anchor` ("Received an incoming payment") -> `completed` ("pending external transfer"), `stellar_transaction_id` equal to the tx above, `amount_in 2.0000000`, `amount_out 1.8`, `fee_details.total 0.2` |

The wallet balance afterwards read 7 USDC (9 - 2).

## 5. Findings that shaped the page

- The anchor's own USDC **deposit** failed twice on 2026-11-27 (`error: Transaction simulation failed: HostError: Error(Contract, #10)`), to a C address and to a G address with a trustline, with 18 USDC in its account. So test USDC cannot come from this anchor right now. The spike bought USDC on the testnet DEX with a throwaway G account (path payment XLM to the Circle USDC, strict send), then moved it into the wallet. For a demo wallet: do the same, or use Circle's testnet faucet.
- The amount in the form can be edited by the user in the popup, so before it sends, the page requires the anchor's `amount_in` to equal the amount the user chose, and refuses otherwise.
- The anchor's token is sent only in an `Authorization` header and kept in memory: never in a URL, a log, or storage.
- The test anchor's `completed` is simulated (no naira, no bank); the page says so wherever it shows the result. Anchor fee shown in the page is the anchor's own quote, never computed by Caracal unless `/info` publishes it.
- Stamp duty note: "1.5% ad valorem, both directions, paid by the transferee; NTA Ninth Schedule item 33" from `docs/research/verify-2026-11-25.md` section 9 (PwC, KPMG, secondary; the gazetted text could not be read). Shown, never deducted.

## 6. Not proven

- A real passkey in a real browser. The signing code path is the kit's own `signAuthEntry`, but the page itself (popup, `kit.signAndSubmit`) was only exercised in unit tests with the kit stubbed.
- Caracal's live relay and OpenZeppelin Channels carrying a muxed-destination transfer: the spike sent the transaction straight to RPC from a throwaway G account. The policy accepts the shape (tested), but the fee-bump path with a muxed `to` is not run. First thing to try end to end.
- Refund, expiry, and `error` withdrawal states of the test anchor (only the success path was seen; the deposit `error` state was seen).
