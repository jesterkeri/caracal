# Caracal split contract

A small Soroban smart contract for Caracal, a non-custodial wallet for Nigerian freelancers on Stellar. When a client pays an invoice in USDC, the contract automatically divides the payment into three pots: **Tax**, **Goal** and **Spend**. The freelancer picks the percentages (in basis points, where 10000 = 100%). Spend is always whatever is left over, so rounding dust is never lost.

Status: Stellar TESTNET only. Built with soroban-sdk 30.0.0.

## Functions

| Function | Who can call | What it does |
|---|---|---|
| `__constructor(owner, token, tax_bps, goal_bps)` | runs once at deploy | Sets the owner, the USDC token and the split. Rejects `tax_bps + goal_bps > 10000`. Being a constructor, it cannot be front-run. |
| `create_invoice(invoice_ref, amount)` | owner only | Opens an invoice for an exact `amount` (above 0). `invoice_ref` must be 1 to 64 bytes. Fails with `InvoiceExists` if that ref was ever created, even if it was paid or cancelled. Emits `invoice_opened`. |
| `cancel_invoice(invoice_ref)` | owner only | Cancels an invoice that is still Open. Paid or already cancelled invoices cannot be cancelled. Emits `invoice_cancelled`. |
| `invoice(invoice_ref)` | anyone (read only) | `(amount, status)` or nothing if unknown. Status is 0 open, 1 paid, 2 cancelled. |
| `deposit(from, amount, invoice_ref)` | the payer (`from`), any payer | Pays an open invoice. `amount` must equal the invoice amount exactly (`WrongAmount` otherwise). Pulls the USDC from `from` and splits it. Tax and Goal are rounded down, the remainder goes to Spend. Rejects the contract itself as payer (`InvalidPayer`), `amount <= 0`, a bad ref, an unknown invoice (`UnknownInvoice`), a paid one (`InvoiceAlreadyPaid`) and a cancelled one (`InvoiceCancelled`). Amounts use checked math (`Overflow` instead of a silent wrap). Emits a `split` event. |
| `is_paid(invoice_ref)` | anyone (read only) | True only if the invoice status is Paid. Stored in persistent storage with an extended lifetime. |
| `balance(pot)` | anyone (read only) | Balance of one pot (`Tax`, `Goal` or `Spend`). |
| `balances()` | anyone (read only) | `(tax, goal, spend)` in one call. |
| `withdraw(pot, to, amount)` | owner only | Sends `amount` of USDC from a pot to `to`. Must be above 0 and at most the pot balance. Emits `withdraw`. |
| `move_between(from_pot, to_pot, amount)` | owner only | Moves money between pots inside the contract. Emits `reallocate`. |
| `reconcile()` | owner only | If someone sent USDC straight to the contract without `deposit`, credits the surplus (token balance minus the three pots) to Spend, emits `reconciled`, returns the amount. |
| `set_split(tax_bps, goal_bps)` | owner only | Changes the percentages for future deposits only. Same bounds check. Emits `split_changed`. |
| `config()` | anyone (read only) | `(owner, token, tax_bps, goal_bps)`. |

Errors: `BpsTooHigh` (1), `InvalidAmount` (2), `InvalidInvoiceRef` (3), `InsufficientBalance` (4), `SamePot` (5), `InvoiceAlreadyPaid` (6), `Overflow` (7), `InvalidPayer` (8), `InvoiceExists` (9), `UnknownInvoice` (10), `WrongAmount` (11), `InvoiceCancelled` (12), `InvalidRecipient` (13, `withdraw` to the contract's own address).

Events carry a version in their topics, for example `("split", "v1")`. The `split` event data holds the opaque `invoice_ref`, payer, token, owner and the amounts. No client names or tax details are ever put on chain: `invoice_ref` is just an opaque id chosen by the app. `withdraw` lowers the pot balance before it calls the token (checks, effects, then interaction), and a failed transfer reverts the whole call.

Every call extends the instance storage lifetime, so the contract is not archived while it is in use.

## Invoices

The owner opens an invoice first with `create_invoice(ref, amount)`. A deposit is only accepted if it names an open invoice and its amount is exactly the invoice amount. An invoice is settled by one deposit of exactly that amount, and then it is Paid for good. There are no partial payments and no overpayments. Anyone may pay it, so a client's colleague can settle it, as long as the amount is exact.

Why: in the first version, `deposit` took any positive amount from anyone and marked the ref as paid. Anyone who learned an invoice id could deposit 1 stroop first. The real client's payment would then fail as a duplicate, and an indexer would show the invoice as paid for the wrong amount. With exact-amount invoices created by the owner, a 1 stroop deposit fails with `WrongAmount`, the invoice stays Open, and the real payment still goes through. A ref can never be created twice, so a paid or cancelled id cannot be reused.

## Who can move money

Only the owner. There is no admin, no upgrade function, no pause switch and no backdoor. The Caracal team cannot move funds, and neither can anyone else. The only code paths that send tokens out of the contract are `withdraw`, which requires the owner's signature. Anyone can deposit into it, but nobody can take money out except the owner. Because the contract cannot be upgraded, the deployed code is the code you can read here.

## Authority table

| Action | Who can do it |
|---|---|
| Sign (authorise the contract's owner-only calls) | owner |
| Create invoice | owner |
| Cancel invoice | owner |
| Deposit (pay an invoice) | anyone, with their own funds, for the exact invoice amount |
| Withdraw | owner |
| Reallocate between pots | owner |
| Change split | owner |
| Reconcile | owner |
| Upgrade | nobody (no upgrade function) |
| Pause | nobody (no pause function) |

## Why one contract per user

Each user gets their own instance. This means:

- Funds of different users can never mix. Each contract holds one person's money and nothing else.
- Auth is simple: there is one owner, and only that owner can withdraw.
- A bug or a bad call in one instance cannot touch another user's money, because they do not share any storage.

## Build, test, deploy

Run these from `contracts/split`.

```sh
# test
cargo test

# build the WASM
stellar contract build

# deploy one instance to testnet (owner = your address)
stellar keys generate caracal-split-deployer --network testnet --fund
stellar contract deploy \
  --wasm target/wasm32v1-none/release/caracal_split.wasm \
  --source caracal-split-deployer --network testnet \
  -- --owner <OWNER_ADDRESS> --token <USDC_SAC_ID> --tax_bps 1000 --goal_bps 1500

# read it back
stellar contract invoke --id <CONTRACT_ID> --source caracal-split-deployer --network testnet -- config
stellar contract invoke --id <CONTRACT_ID> --source caracal-split-deployer --network testnet -- balances
```

The USDC token id on testnet is the Stellar Asset Contract for `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`:

```sh
stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet
```

## Testnet deployment

Current instance (2026-11-25, `withdraw` refuses the contract's own address as recipient):

- Contract id: `CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M`
  https://stellar.expert/explorer/testnet/contract/CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M
- WASM hash (sha256): `b97d71c33aa88dbc12bacb07f4903590e2a0ad4fc4729219e8e9c94d6c2f8c58`
- Owner: `GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX` (a test deployer account), split 1000 / 1500 bps
- USDC SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
- Deploy tx: https://stellar.expert/explorer/testnet/tx/9db1ab3c8bd1e60bfac9230d6cae0ba50c26ade8a831988e2057014d5d91e340
- `create_invoice` for `INV-DAY2-2`, 100000 (0.01 USDC): https://stellar.expert/explorer/testnet/tx/bc24a22ffcc4d69fe8b0d4538157df16f22c7b4f8f7db3bfa599aa7b94d633a3
- Deposit of exactly 100000: https://stellar.expert/explorer/testnet/tx/7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb
- `withdraw` of 1000 from Spend to the contract's own id failed with `Error(Contract, #13)` (`InvalidRecipient`). This was a simulation failure, so there is no transaction. `balances()` afterwards returns Tax 10000, Goal 15000, Spend 75000.

Superseded instances, kept for the record: `CAD5AH4U3ONNMZJKYC2BECMOMFACKG4JGNYLZIEERSIYWX2NAC26DVVB` (`withdraw` to the contract's own id debited a pot and emitted `Withdraw` without moving tokens; WASM hash `70fb8ddce2908fc095439eb57f099fe559d8ffee85fe76750d48ec93059a990d`, deploy tx `7c61879a4ab63e21a7310ba2aa6d525f23b888be9943068821d083573961cd2e`), `CB2WIGKDHY542ZLLQQPK7JB2ZN2NL25JLQT7YADWEWMEAHDXFWCFLGQ2` (had the payer guard but accepted any amount for any ref, so an invoice could be burned with a 1 stroop deposit; WASM hash `24d6dafcf0d0204ce0437071191562003bc4fea039fc92ee5746c10e30ccaf13`, deploy tx `fbbca774a2697d096eecec2f4913b916b3e82c92e7dc6b14aca0e04151488cef`), `CAFE6AQXMBMOEN6GYQQS6LEF24OA6E4QKRXM2YQ5JOQ4EMX6B64T6NBM` (no payer guard; deploy tx `b3c3e07d8b3c2cde69b855e243300912f206df965afd8c852529afed479f9e23`) and `CAQS7SINILCN4C2QZ42CQDSWDJQZT4KKYBQNG7DRGR6PLDZXHVL6DOSO` (first version). Their test USDC stays withdrawable by the owner.
