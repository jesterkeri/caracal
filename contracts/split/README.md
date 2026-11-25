# Caracal split contract

A small Soroban smart contract for Caracal, a non-custodial wallet for Nigerian freelancers on Stellar. When a client pays an invoice in USDC, the contract automatically divides the payment into three pots: **Tax**, **Goal** and **Spend**. The freelancer picks the percentages (in basis points, where 10000 = 100%). Spend is always whatever is left over, so rounding dust is never lost.

Status: Stellar TESTNET only. Built with soroban-sdk 30.0.0.

## Functions

| Function | Who can call | What it does |
|---|---|---|
| `__constructor(owner, token, tax_bps, goal_bps)` | runs once at deploy | Sets the owner, the USDC token and the split. Rejects `tax_bps + goal_bps > 10000`. Being a constructor, it cannot be front-run. |
| `deposit(from, amount, invoice_ref)` | the payer (`from`) | Pulls `amount` of USDC from `from` into the contract and splits it. Tax and Goal are rounded down, the remainder goes to Spend. Rejects `amount <= 0`, an empty `invoice_ref`, or one longer than 64 bytes. Each `invoice_ref` can be paid only once (`InvoiceAlreadyPaid`). Amounts use checked math (`Overflow` instead of a silent wrap). Emits a `split` event. |
| `is_paid(invoice_ref)` | anyone (read only) | True if that invoice id was already paid. Stored in persistent storage with an extended lifetime. |
| `balance(pot)` | anyone (read only) | Balance of one pot (`Tax`, `Goal` or `Spend`). |
| `balances()` | anyone (read only) | `(tax, goal, spend)` in one call. |
| `withdraw(pot, to, amount)` | owner only | Sends `amount` of USDC from a pot to `to`. Must be above 0 and at most the pot balance. Emits `withdraw`. |
| `move_between(from_pot, to_pot, amount)` | owner only | Moves money between pots inside the contract. Emits `reallocate`. |
| `reconcile()` | owner only | If someone sent USDC straight to the contract without `deposit`, credits the surplus (token balance minus the three pots) to Spend, emits `reconciled`, returns the amount. |
| `set_split(tax_bps, goal_bps)` | owner only | Changes the percentages for future deposits only. Same bounds check. Emits `split_changed`. |
| `config()` | anyone (read only) | `(owner, token, tax_bps, goal_bps)`. |

Errors: `BpsTooHigh` (1), `InvalidAmount` (2), `InvalidInvoiceRef` (3), `InsufficientBalance` (4), `SamePot` (5), `InvoiceAlreadyPaid` (6), `Overflow` (7).

Events carry a version in their topics, for example `("split", "v1")`. The `split` event data holds the opaque `invoice_ref`, payer, token, owner and the amounts. No client names or tax details are ever put on chain: `invoice_ref` is just an opaque id chosen by the app. `withdraw` lowers the pot balance before it calls the token (checks, effects, then interaction), and a failed transfer reverts the whole call.

Every call extends the instance storage lifetime, so the contract is not archived while it is in use.

## Who can move money

Only the owner. There is no admin, no upgrade function, no pause switch and no backdoor. The Caracal team cannot move funds, and neither can anyone else. The only code paths that send tokens out of the contract are `withdraw`, which requires the owner's signature. Anyone can deposit into it, but nobody can take money out except the owner. Because the contract cannot be upgraded, the deployed code is the code you can read here.

## Authority table

| Action | Who can do it |
|---|---|
| Sign (authorise the contract's owner-only calls) | owner |
| Deposit | anyone, with their own funds |
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

- Contract id: `CAFE6AQXMBMOEN6GYQQS6LEF24OA6E4QKRXM2YQ5JOQ4EMX6B64T6NBM`
  https://stellar.expert/explorer/testnet/contract/CAFE6AQXMBMOEN6GYQQS6LEF24OA6E4QKRXM2YQ5JOQ4EMX6B64T6NBM
- WASM hash (sha256): `381face44bca07411ed0baa513cfad564e544fb8b99fb02ef0d9bba10449ec76`
  https://stellar.expert/explorer/testnet/contract-wasm/381face44bca07411ed0baa513cfad564e544fb8b99fb02ef0d9bba10449ec76
- Owner: `GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX`, split 1000 / 1500 bps
- USDC SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
- Deploy tx: https://stellar.expert/explorer/testnet/tx/b3c3e07d8b3c2cde69b855e243300912f206df965afd8c852529afed479f9e23
- Test deposit of 1.5 USDC, invoice `INV-TEST-4`: https://stellar.expert/explorer/testnet/tx/867ffa6878852da2fe1b51b0b18383a4ebc77bb9ea0ce794762aeeacc7c66bb2
  A second deposit with the same invoice id was rejected on chain with error 6 (`InvoiceAlreadyPaid`).
  Pots now (7-decimal units): Tax 1500030, Goal 2250045, Spend 11250225 (the extra 300 units come from three 100-unit test deposits).
- The earlier first-version instance (`CAQS7SINILCN4C2QZ42CQDSWDJQZT4KKYBQNG7DRGR6PLDZXHVL6DOSO`) is superseded and holds 3 USDC from a test deposit; the owner can withdraw it.
