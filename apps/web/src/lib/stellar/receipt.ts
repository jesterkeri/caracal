// A payment's split receipt, read from the chain: the `split` event that
// Caracal's split contract emits on every deposit (contracts/split, topics
// ["split", "v1"]) carries the exact amounts set aside for tax, the savings
// goal, and spending. Nothing here is computed from percentages.
//
// Anyone can deploy a contract that emits an event named "split", so an event
// counts only if the contract that emitted it ran Caracal's split wasm in that
// same transaction. That is read from the transaction's own ledger changes,
// not from the contract's wasm today: an upgradeable look-alike could forge
// an event and switch to Caracal's wasm afterwards. A genuine deposit always
// rewrites the split contract's instance (its pots live there), so the
// instance appears in the changes with its state from before the transaction
// (or its restored state, if it had been archived). That earlier state must be
// there, and every state of the instance must carry Caracal's wasm: a contract
// created inside the transaction shows only its final wasm, which says nothing
// about the code that ran when it emitted.

import { Address, StrKey, TransactionBuilder, rpc, scValToNative, xdr, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
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
      /** The account (G..., muxed ids removed) that paid the network fee, and how much (stroops). */
      feePayer: string;
      feeCharged: bigint;
      receipts: SplitReceipt[];
    }
  /** The RPC keeps only recent history, so an old payment and a wrong hash look the same. */
  | { kind: "not-found" }
  | { kind: "failed" }
  /** The transaction recorded no split by a confirmed Caracal split contract. */
  | { kind: "no-split" }
  | { kind: "unreachable" }
  /** The RPC answered, but with data Caracal could not read. */
  | { kind: "unreadable" }
  /** This server's RPC setting cannot be used. */
  | { kind: "not-set-up" };

export const isTxHash = (s: string) => /^[0-9a-f]{64}$/.test(s);

export type ReceiptDeps = {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  networkPassphrase: string;
};

export async function readSplitReceipt(hash: string, deps: ReceiptDeps): Promise<ReceiptRead> {
  let tx: rpc.Api.GetTransactionResponse;
  try {
    tx = await deps.getTransaction(hash);
  } catch (e) {
    console.error("could not read the transaction:", e instanceof Error ? e.message : String(e));
    // The SDK parses the answer inside the same call; an answer it cannot parse
    // came back from the network, so it is not "could not reach".
    return { kind: isXdrError(e) ? "unreadable" : "unreachable" };
  }
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { kind: "not-found" };
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) return { kind: "failed" };

  try {
    // The SDK passes the RPC's close time on as it came (a numeric string today).
    const ledger = Number(tx.ledger);
    const closed = Number(tx.createdAt);
    if (!Number.isSafeInteger(ledger) || ledger <= 0 || !Number.isSafeInteger(closed) || closed <= 0) {
      throw new Error(`unusable ledger ${tx.ledger} or close time ${tx.createdAt}`);
    }
    const instances = instanceStates(tx.resultMetaXdr);
    const receipts = contractEvents(tx)
      .map(decodeSplitEvent)
      .filter((r): r is SplitReceipt => r !== null)
      .filter((r) => {
        const seen = instances.get(r.splitContract);
        return seen !== undefined && seen.before > 0 && seen.wasms.every((w) => w === SPLIT.wasmHash);
      });
    if (receipts.length === 0) return { kind: "no-split" };

    const envelope = TransactionBuilder.fromXDR(tx.envelopeXdr, deps.networkPassphrase) as Transaction | FeeBumpTransaction;
    return {
      kind: "found",
      hash,
      ledger,
      closedAt: new Date(closed * 1000),
      feePayer: baseAccount("feeSource" in envelope ? envelope.feeSource : envelope.source),
      feeCharged: BigInt(tx.resultXdr.feeCharged().toString()),
      receipts,
    };
  } catch (e) {
    console.error("could not read the transaction's details:", e instanceof Error ? e.message : String(e));
    return { kind: "unreadable" };
  }
}

/** js-xdr reports a value it cannot decode as a TypeError of its own kind, or "Bad union switch". */
function isXdrError(e: unknown): boolean {
  return e instanceof TypeError && (/^Xdr/.test(e.name) || /^(Bad union switch|XDR )/i.test(e.message));
}

/**
 * The transaction's contract events, read from its meta: the same record the
 * instance states come from, and present whether or not the RPC also fills in
 * its separate `events` field.
 */
function contractEvents(tx: rpc.Api.GetSuccessfulTransactionResponse): xdr.ContractEvent[] {
  const m = tx.resultMetaXdr;
  if (m.switch() === 4) return m.v4().operations().flatMap((op) => op.events());
  if (m.switch() === 3) return m.v3().sorobanMeta()?.events() ?? [];
  throw new Error(`unsupported transaction meta version ${m.switch()}`);
}

/**
 * For each contract whose instance entry this transaction touched: the wasm
 * hash of every state of that entry in the ledger changes (transaction and
 * operation level; a non-wasm executable counts as ""), and how many of those
 * are its state from before the transaction (`ledgerEntryState`, or
 * `ledgerEntryRestored` for an entry brought back from the archive).
 */
export function instanceStates(meta: xdr.TransactionMeta): Map<string, { wasms: string[]; before: number }> {
  const out = new Map<string, { wasms: string[]; before: number }>();
  const changes: xdr.LedgerEntryChange[] = [];
  const v = meta.switch();
  if (v === 3 || v === 4) {
    const m = v === 3 ? meta.v3() : meta.v4();
    changes.push(...m.txChangesBefore(), ...m.txChangesAfter());
    for (const op of m.operations()) changes.push(...op.changes());
  } else {
    throw new Error(`unsupported transaction meta version ${v}`);
  }
  for (const c of changes) {
    const type = c.switch().name;
    if (type === "ledgerEntryRemoved") continue; // a key only, no state
    const entry = c.value() as xdr.LedgerEntry;
    const d = entry.data();
    if (d.switch().name !== "contractData") continue;
    const cd = d.contractData();
    if (cd.key().switch().name !== "scvLedgerKeyContractInstance" || cd.val().switch().name !== "scvContractInstance") continue;
    const exe = cd.val().instance().executable();
    const wasm = exe.switch().name === "contractExecutableWasm" ? exe.wasmHash().toString("hex") : "";
    const id = Address.fromScAddress(cd.contract()).toString();
    const seen = out.get(id) ?? { wasms: [], before: 0 };
    seen.wasms.push(wasm);
    if (type === "ledgerEntryState" || type === "ledgerEntryRestored") seen.before += 1;
    out.set(id, seen);
  }
  return out;
}

/** The G... account behind a muxed M... address; anything else unchanged. */
export function baseAccount(a: string): string {
  return StrKey.isValidMed25519PublicKey(a) ? StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(a).subarray(0, 32)) : a;
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

/**
 * An invoice reference for display. Plain printable ASCII as is; text with
 * spaces that would not show (leading, trailing, doubled, or only spaces) in
 * quotes; anything else as 0x-prefixed hex. So no two references look alike.
 */
function refText(b: Uint8Array): string {
  const printable = b.length > 0 && b.every((c) => c >= 0x20 && c <= 0x7e);
  if (!printable) return `0x${Buffer.from(b).toString("hex")}`;
  const t = Buffer.from(b).toString("latin1");
  if (t.startsWith("0x") || t.startsWith('"') || t !== t.trim() || t.includes("  ")) return JSON.stringify(t);
  return t;
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
