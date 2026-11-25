# Caracal split contract

A small Soroban smart contract for Caracal, a non-custodial wallet for Nigerian freelancers on Stellar. When a client pays an invoice in USDC, the contract automatically divides the payment into three pots: **Tax**, **Goal** and **Spend**. The freelancer picks the percentages (in basis points, where 10000 = 100%). Spend is always whatever is left over, so rounding dust is never lost.

Status: Stellar TESTNET only. Built with soroban-sdk 30.0.0.

## Functions

| Function | Who can call | What it does |
|---|---|---|
| `__constructor(owner, token, tax_bps, goal_bps)` | runs once at deploy | Sets the owner, the USDC token and the split. Rejects `tax_bps + goal_bps > 10000`. Being a constructor, it cannot be front-run. |
| `deposit(from, amount, invoice_ref)` | the payer (`from`) | Pulls `amount` of USDC from `from` into the contract and splits it. Tax and Goal are rounded down, the remainder goes to Spend. Rejects `amount <= 0`, an empty `invoice_ref`, or one longer than 64 bytes. Emits a `split` event. |
| `balance(pot)` | anyone (read only) | Balance of one pot (`Tax`, `Goal` or `Spend`). |
| `balances()` | anyone (read only) | `(tax, goal, spend)` in one call. |
| `withdraw(pot, to, amount)` | owner only | Sends `amount` of USDC from a pot to `to`. Must be above 0 and at most the pot balance. Emits `withdraw`. |
| `move_between(from_pot, to_pot, amount)` | owner only | Moves money between pots inside the contract. Emits `reallocate`. |
| `set_split(tax_bps, goal_bps)` | owner only | Changes the percentages for future deposits only. Same bounds check. Emits `split_changed`. |
| `config()` | anyone (read only) | `(owner, token, tax_bps, goal_bps)`. |

Errors: `BpsTooHigh` (1), `InvalidAmount` (2), `InvalidInvoiceRef` (3), `InsufficientBalance` (4), `SamePot` (5).

Every call extends the instance storage lifetime, so the contract is not archived while it is in use.

## Who can move money

Only the owner. There is no admin, no upgrade function, no pause switch and no backdoor. The Caracal team cannot move funds, and neither can anyone else. The only code paths that send tokens out of the contract are `withdraw`, which requires the owner's signature. Anyone can deposit into it, but nobody can take money out except the owner. Because the contract cannot be upgraded, the deployed code is the code you can read here.

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

- Contract id: `CAQS7SINILCN4C2QZ42CQDSWDJQZT4KKYBQNG7DRGR6PLDZXHVL6DOSO`
  https://stellar.expert/explorer/testnet/contract/CAQS7SINILCN4C2QZ42CQDSWDJQZT4KKYBQNG7DRGR6PLDZXHVL6DOSO
- WASM hash (sha256): `1d35a28dbe730f4ecb109ef743138d9c26c56583f3f6c00c0b942c9411f9a798`
  https://stellar.expert/explorer/testnet/contract-wasm/1d35a28dbe730f4ecb109ef743138d9c26c56583f3f6c00c0b942c9411f9a798
- Owner: `GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX`, split 1000 / 1500 bps
- USDC SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
- Deploy tx: https://stellar.expert/explorer/testnet/tx/0d36e9a9630d38a862a115b5724a92d46010e24f85486a9cbe5211c725dc1a00
- Test deposit of 3 USDC, invoice `INV-TEST-1`: https://stellar.expert/explorer/testnet/tx/1eb87442e115a9dba201642e75007debe50ef42d853b740769999bbffb28cd70
  Result: Tax 3.0, Goal 4.5, Spend 22.5 (in 7-decimal units: 3000000, 4500000, 22500000).
