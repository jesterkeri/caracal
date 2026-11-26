// A payment's split receipt, read from the chain: the `split` event that
// Caracal's split contract emits on every deposit (contracts/split, topics
// ["split", "v1"]) carries the exact amounts set aside for tax, the savings
// goal, and spending. Nothing here is computed from percentages.
//
// Anyone can deploy a contract that emits an event named "split", so an event
// counts only if the contract that emitted it runs Caracal's split wasm. The
// split contract has no upgrade function, so its wasm today is its wasm then.

import { Address, StrKey, TransactionBuilder, rpc, scValToNative, xdr, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import { ContractNotFound, type WasmLookup } from "../relay/policy";
import { SPLIT, TOKENS } from "./config";

/** One payment into a split contract, as the contract recorded it. Amounts in USDC's smallest unit (7 decimals). */
export type SplitReceipt = {
  splitContract: string;
  invoiceRef: string;
  from: string;
  owner: string;
  amount: bigint;
  tax: bigint;
  goal: bigint;
  spend: bigint;
};

export type ReceiptRead =
  | {
      kind: "found";
      hash: string;
      ledger: number;
      closedAt: Date;
      /** The account that paid the network fee, and how much (stroops). */
      feePayer: string;
      feeCharged: bigint;
      receipts: SplitReceipt[];
    }
  /** The RPC keeps only recent history, so an old payment and a wrong hash look the same. */
  | { kind: "not-found" }
  | { kind: "failed" }
  /** The transaction recorded no split by a confirmed Caracal split contract. */
  | { kind: "no-split" }
  | { kind: "unreachable" };

export const isTxHash = (s: string) => /^[0-9a-f]{64}$/.test(s);

export type ReceiptDeps = {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  lookupWasm: WasmLookup;
  networkPassphrase: string;
};

export async function readSplitReceipt(hash: string, deps: ReceiptDeps): Promise<ReceiptRead> {
  let tx: rpc.Api.GetTransactionResponse;
  try {
    tx = await deps.getTransaction(hash);
  } catch (e) {
    console.error("could not read the transaction:", e instanceof Error ? e.message : String(e));
    return { kind: "unreachable" };
  }
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { kind: "not-found" };
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) return { kind: "failed" };

  const candidates = (tx.events?.contractEventsXdr ?? []).flat().map(decodeSplitEvent).filter((r): r is SplitReceipt => r !== null);
  const receipts: SplitReceipt[] = [];
  for (const r of candidates) {
    let wasm: string | null;
    try {
      wasm = await deps.lookupWasm(r.splitContract);
    } catch (e) {
      // A contract the RPC cannot return (or an RPC failure) is not confirmed,
      // so its event is not shown as a Caracal receipt.
      console.error("could not confirm the split contract:", e instanceof Error ? e.message : String(e));
      if (!(e instanceof ContractNotFound)) return { kind: "unreachable" };
      continue;
    }
    if (wasm === SPLIT.wasmHash) receipts.push(r);
  }
  if (receipts.length === 0) return { kind: "no-split" };

  const envelope = TransactionBuilder.fromXDR(tx.envelopeXdr, deps.networkPassphrase) as Transaction | FeeBumpTransaction;
  const feePayer = "feeSource" in envelope ? envelope.feeSource : envelope.source;
  return {
    kind: "found",
    hash,
    ledger: tx.ledger,
    closedAt: new Date(tx.createdAt * 1000),
    feePayer,
    feeCharged: BigInt(tx.resultXdr.feeCharged().toString()),
    receipts,
  };
}

/** A `split` v1 event with the shape contracts/split emits, or null. */
export function decodeSplitEvent(e: xdr.ContractEvent): SplitReceipt | null {
  try {
    if (e.type().name !== "contract") return null;
    const id = e.contractId();
    if (!id) return null;
    const body = e.body().v0();
    const topics = body.topics();
    if (topics.length !== 2 || !isSym(topics[0]!, "split") || !isSym(topics[1]!, "v1")) return null;
    const d = scValToNative(body.data()) as Record<string, unknown>;
    const { amount, tax, goal, spend, from, owner, token, invoice_ref } = d;
    if (![amount, tax, goal, spend].every((v) => typeof v === "bigint")) return null;
    if (typeof from !== "string" || typeof owner !== "string" || token !== TOKENS.usdc) return null;
    if (!(invoice_ref instanceof Uint8Array)) return null;
    const [a, t, g, s] = [amount, tax, goal, spend] as bigint[];
    if (t! < BigInt(0) || g! < BigInt(0) || s! < BigInt(0) || t! + g! + s! !== a!) return null;
    return {
      splitContract: Address.contract(id as unknown as Buffer).toString(),
      invoiceRef: refText(invoice_ref),
      from,
      owner,
      amount: a!,
      tax: t!,
      goal: g!,
      spend: s!,
    };
  } catch {
    return null;
  }
}

const isSym = (v: xdr.ScVal, s: string) => v.switch().name === "scvSymbol" && v.sym().toString() === s;

/** Printable ASCII as text (invoice references are), anything else as hex. */
function refText(b: Uint8Array): string {
  return b.length > 0 && b.every((c) => c >= 0x20 && c <= 0x7e) ? Buffer.from(b).toString("latin1") : Buffer.from(b).toString("hex");
}

/** USDC (7 decimals) as text, exact: 100000 units -> "0.01", 1234567890 -> "123.456789". At least two decimals. */
export function formatUsdc(units: bigint): string {
  const neg = units < BigInt(0);
  const v = neg ? -units : units;
  const whole = v / BigInt(10_000_000);
  let frac = (v % BigInt(10_000_000)).toString().padStart(7, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

/** XLM stroops as text, exact. */
export function formatXlm(stroops: bigint): string {
  const frac = (stroops % BigInt(10_000_000)).toString().padStart(7, "0").replace(/0+$/, "");
  return `${stroops / BigInt(10_000_000)}${frac ? `.${frac}` : ""}`;
}

/** G... or C... shortened for display. */
export const shortAddress = (a: string) => (StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a) ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
