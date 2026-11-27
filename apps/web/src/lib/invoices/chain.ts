// Reads and writes on a Caracal split contract: the invoice calls only.
// Reads are simulations (no signature, no fee). Writes are built as a stellar-sdk
// AssembledTransaction and go through smart-account-kit 0.10.0's signAndSubmit,
// which asks for the passkey and posts { func, auth } to /api/relay.

import { Buffer } from "buffer";
import { Account, Address, TransactionBuilder, BASE_FEE, Contract, contract, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { SmartAccountKit } from "smart-account-kit";
import { NETWORK, TOKENS } from "../stellar/config";
import { splitAddressFor } from "../stellar/split-address";
import { splitErrorText } from "./errors";
import { refBytes } from "./ref";

export type InvoiceStatus = "open" | "paid" | "cancelled";
export type InvoiceOnChain = { amount: bigint; status: InvoiceStatus };
export type SplitConfig = { owner: string; token: string };

/** Anything an RPC read needs: the part of rpc.Server used here. */
export type Reader = Pick<rpc.Server, "simulateTransaction">;

/** The network answered, and said the call fails (for a read: no such contract, say). Not the same as not answering. */
export class ReadRefused extends Error {}

// A read-only simulation needs a source account only in name; this is the one smart-account-kit uses.
const READ_SOURCE = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");

async function simulateRead(server: Reader, contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal | undefined> {
  const tx = new TransactionBuilder(READ_SOURCE, { fee: BASE_FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new ReadRefused(sim.error);
  return sim.result?.retval;
}

const STATUS: Record<number, InvoiceStatus> = { 0: "open", 1: "paid", 2: "cancelled" };

/**
 * invoice(ref) on the split contract. Null when the chain has no such invoice;
 * throws when the network cannot be asked or says something unexpected (an
 * unknown answer is never turned into "no invoice").
 */
export async function readInvoice(server: Reader, split: string, ref: string): Promise<InvoiceOnChain | null> {
  const bytes = refBytes(ref);
  if (!bytes) throw new Error("The invoice id is not valid");
  const ret = await simulateRead(server, split, "invoice", [xdr.ScVal.scvBytes(bytes)]);
  if (!ret) throw new Error("The network did not return an answer for this invoice");
  if (ret.switch().name === "scvVoid") return null;
  const v = scValToNative(ret) as unknown;
  if (!Array.isArray(v) || typeof v[0] !== "bigint" || typeof v[1] !== "number" || !(v[1] in STATUS)) {
    throw new Error("The contract returned an invoice in a form Caracal does not know");
  }
  return { amount: v[0], status: STATUS[v[1]] };
}

/**
 * config() on the split contract: its owner and token. Null when no contract
 * answers at that address (the network answered and refused the call); throws
 * when the network cannot be asked.
 */
export async function readConfig(server: Reader, split: string): Promise<SplitConfig | null> {
  let ret: xdr.ScVal | undefined;
  try {
    ret = await simulateRead(server, split, "config", []);
  } catch (e) {
    if (e instanceof ReadRefused) return null;
    throw e;
  }
  const v = ret ? (scValToNative(ret) as unknown) : null;
  if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string") return null;
  return { owner: v[0], token: v[1] };
}

/** A wallet's testnet USDC balance in stroops. Throws when the network cannot be asked. */
export async function readUsdcBalance(server: Reader, wallet: string): Promise<bigint> {
  const ret = await simulateRead(server, TOKENS.usdc, "balance", [new Address(wallet).toScVal()]);
  const v = ret ? (scValToNative(ret) as unknown) : null;
  if (typeof v !== "bigint") throw new Error("The network did not return a USDC balance");
  return v;
}

/**
 * Whether `split` is a Caracal split contract as far as a read can tell: it
 * holds testnet USDC, and its address is the one derived from its owner's
 * wallet. A link that points at anything else is refused before any payment.
 */
export function isCaracalSplit(split: string, cfg: SplitConfig): boolean {
  if (cfg.token !== TOKENS.usdc) return false;
  try {
    return splitAddressFor(cfg.owner) === split;
  } catch {
    return false;
  }
}

/** Newest first would need paging backwards; the node keeps about a week, so one forward pass is enough. */
const EVENT_WINDOW_LEDGERS = 120_000;
const MAX_EVENT_PAGES = 10;

/** The part of rpc.Server used to find a payment. */
export type EventReader = Pick<rpc.Server, "getEvents" | "getLatestLedger">;

/**
 * The transaction that paid `ref`, found in the contract's `split` events on
 * the node's recent history (about a week). Null when it is not there (an older
 * payment, or none); never throws, since this only adds a receipt link.
 */
export async function findPaymentTx(server: EventReader, split: string, ref: string): Promise<string | null> {
  const wanted = refBytes(ref);
  if (!wanted) return null;
  try {
    const latest = await server.getLatestLedger();
    const filters = [{ type: "contract" as const, contractIds: [split] }];
    let page = await server.getEvents({ startLedger: Math.max(1, latest.sequence - EVENT_WINDOW_LEDGERS), filters, limit: 200 });
    for (let i = 0; i < MAX_EVENT_PAGES; i++) {
      for (const ev of page.events) {
        const name = ev.topic[0]?.switch().name === "scvSymbol" ? ev.topic[0].sym().toString() : "";
        if (name !== "split" || !ev.inSuccessfulContractCall) continue;
        const data = scValToNative(ev.value) as { invoice_ref?: Uint8Array } | null;
        if (data?.invoice_ref && Buffer.from(data.invoice_ref).equals(wanted)) return ev.txHash;
      }
      if (page.events.length < 200) return null;
      page = await server.getEvents({ cursor: page.cursor, filters, limit: 200 });
    }
  } catch {
    // no receipt link, that is all
  }
  return null;
}

/** What happened to a write, in the words the page needs. */
export type WriteOutcome =
  // Landed and succeeded.
  | { kind: "done"; hash: string }
  // Nothing was sent: it failed before any transaction left (passkey refused, the call fails when tried, or the relay said so).
  | { kind: "not-sent"; message: string }
  // Reached the chain and failed there. Nothing moved.
  | { kind: "failed"; message: string; hash: string }
  // The answer was lost or unclear. It may have landed.
  | { kind: "unknown"; message: string; hash?: string };

const NOT_SENT_CODES = new Set([2001, 4001, 4002, 4003, 4004, 5001, 10000]);

type Submitter = Pick<SmartAccountKit, "signAndSubmit" | "rpc">;

/** Sends one split call from the connected wallet. `args` are the contract's arguments. */
export async function sendCall(kit: Submitter, split: string, method: string, args: xdr.ScVal[]): Promise<WriteOutcome> {
  let tx: contract.AssembledTransaction<unknown>;
  try {
    tx = await contract.AssembledTransaction.build({
      contractId: split,
      method,
      args,
      networkPassphrase: NETWORK.passphrase,
      rpcUrl: NETWORK.rpcUrl,
      server: kit.rpc,
      parseResultXdr: (v: xdr.ScVal) => v,
    });
  } catch (e) {
    return { kind: "not-sent", message: (e instanceof Error && splitErrorText(e.message, split)) || `Caracal could not prepare the call. ${msg(e)}` };
  }
  if (tx.simulation && rpc.Api.isSimulationError(tx.simulation)) {
    const text = tx.simulation.error;
    return { kind: "not-sent", message: splitErrorText(text, split) ?? `The network refused the call when it was tried: ${text}` };
  }
  let result: Awaited<ReturnType<Submitter["signAndSubmit"]>>;
  try {
    result = await kit.signAndSubmit(tx);
  } catch (e) {
    return { kind: "unknown", message: msg(e) };
  }
  if (result.success) return { kind: "done", hash: result.hash };
  const text = result.error.message;
  const code = (result.error as { code?: number }).code;
  const hash = typeof result.hash === "string" && result.hash !== "" ? result.hash : undefined;
  const readable = splitErrorText(text, split) ?? (/Transaction failed on-chain/.test(text) ? "The network rejected the transaction." : text);
  if (text.includes("Nothing was sent") || (code !== undefined && NOT_SENT_CODES.has(code))) return { kind: "not-sent", message: readable };
  if (hash && /Transaction failed on-chain/.test(text)) return { kind: "failed", message: readable, hash };
  return { kind: "unknown", message: readable, hash };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const bytesArg = (ref: string): xdr.ScVal => {
  const b = refBytes(ref);
  if (!b) throw new Error("The invoice id is not valid");
  return xdr.ScVal.scvBytes(b);
};
const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });

/** create_invoice(ref, amount): the owner opens an invoice for an exact amount. */
export const createInvoice = (kit: Submitter, split: string, ref: string, amount: bigint) =>
  sendCall(kit, split, "create_invoice", [bytesArg(ref), i128(amount)]);

/** cancel_invoice(ref): the owner cancels an open invoice. */
export const cancelInvoice = (kit: Submitter, split: string, ref: string) => sendCall(kit, split, "cancel_invoice", [bytesArg(ref)]);

/** deposit(from, amount, ref): the payer's wallet pays the invoice's exact amount in USDC. */
export const payInvoice = (kit: Submitter, split: string, from: string, amount: bigint, ref: string) =>
  sendCall(kit, split, "deposit", [new Address(from).toScVal(), i128(amount), bytesArg(ref)]);
