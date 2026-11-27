// Shared by the adversary-t1 tests. Chain answers are CONSTRUCTED in the real
// Soroban RPC wire format (same encoder as tax-pipeline.test.ts); the CBN rates
// are the real captured rows in fixtures/tax/cbn-nfem-rates.json.
import { readFileSync } from "node:fs";
import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { parseNfemTable } from "../src/lib/tax/cbn-rates";
import type { ChainReader, RawEvent } from "../src/lib/tax/chain-payments";
import type { PipelineDeps, TaxRequest } from "../src/lib/tax/pipeline";

export const rates = parseNfemTable((JSON.parse(readFileSync(new URL("./fixtures/tax/cbn-nfem-rates.json", import.meta.url), "utf8")) as { rows: unknown[] }).rows);
export const WALLET = StrKey.encodeContract(Buffer.alloc(32, 9));
export const CONTRACT = splitAddressFor(WALLET);
export const NOW = new Date("2026-11-27T15:00:00Z");
export const unix = (iso: string) => String(Date.parse(iso) / 1000);
export const cursorFor = (ledger: number) => `${(BigInt(ledger) * BigInt(4294967296)).toString().padStart(19, "0")}-4294967295`;
const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const map = (entries: [string, xdr.ScVal][]) => xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));

export type Tx = { status: string; ledger: number; createdAt: string };
export type Item = { event: RawEvent; tx: Tx };
let seq = 0;

function wrap(topic: string, closedAt: string, value: xdr.ScVal): Item {
  const n = ++seq;
  const ledger = 5900000 + n;
  return {
    event: { type: "contract", ledger, ledgerClosedAt: closedAt, contractId: CONTRACT, id: `${String(ledger).padStart(19, "0")}-0000000001`, txHash: String(n).padStart(64, "0"), topic: [sym(topic), sym("v1")], value: value.toXDR("base64") },
    tx: { status: "SUCCESS", ledger, createdAt: unix(closedAt) },
  };
}

/** A `split` v1 event paid by `from` (default: a third party's contract address). */
export function payment(closedAt: string, units: number, from: string = StrKey.encodeContract(Buffer.alloc(32, 5))): Item {
  const amount = BigInt(units);
  const tax = amount / BigInt(10);
  const goal = amount / BigInt(10);
  return wrap(
    "split",
    closedAt,
    map([
      ["amount", i128(amount)],
      ["from", Address.fromString(from).toScVal()],
      ["goal", i128(goal)],
      ["invoice_ref", xdr.ScVal.scvBytes(Buffer.from(`INV-${seq + 1}`))],
      ["owner", Address.fromString(WALLET).toScVal()],
      ["spend", i128(amount - tax - goal)],
      ["tax", i128(tax)],
      ["token", Address.fromString(TOKENS.usdc).toScVal()],
    ]),
  );
}

/** A `reconciled` v1 event: contracts/split `reconcile()` crediting USDC sent straight to the contract. */
export const reconciled = (closedAt: string, units: number): Item => wrap("reconciled", closedAt, map([["amount", i128(BigInt(units))]]));

export function chain(items: Item[], oldest = "2025-12-01T00:00:00Z"): ChainReader {
  const retention = { latestLedger: 6000000, oldestLedger: 5000000, latestLedgerCloseTime: unix("2026-11-27T14:59:30Z"), oldestLedgerCloseTime: unix(oldest) };
  return {
    health: async () => retention,
    instance: async () => ({ kind: "wasm", hash: SPLIT.wasmHash }),
    // Balanced: everything the contract holds is in its pots (holdings is a required read).
    holdings: async () => ({ held: BigInt(0), pots: BigInt(0) }),
    events: async () => ({ ...retention, events: items.map((p) => p.event), cursor: cursorFor(6000000) }),
    eventsAfter: async () => ({ ...retention, events: [], cursor: cursorFor(6000000) }),
    transaction: async (hash) => items.find((p) => p.event.txHash === hash)!.tx,
  };
}

export const deps = (c: ChainReader): PipelineDeps => ({ chain: c, rateTable: async () => rates, now: () => NOW });
export const req: TaxRequest = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" } };
