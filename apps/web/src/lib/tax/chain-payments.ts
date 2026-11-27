// A wallet's payments, read from the chain: the `split` events its split
// contract emitted (contracts/split, topics ["split", "v1"]; see
// contracts/split/README.md). The amount of a payment is the event's `amount`,
// the whole USDC payment before it was divided into tax, goal and spend.
//
// Coverage. A Soroban RPC keeps events for a limited window only (the
// testnet's public RPC reports `ledgerRetentionWindow` 120960 ledgers, about 7
// days). Everything older is gone, and the RPC cannot say what was in it. So
// the coverage this module can prove is: every event from the oldest retained
// ledger up to the newest ledger it scanned. That window is returned with the
// payments, and the tax engine refuses when it does not cover the tax year.
// Nothing here pretends the window is longer.

import { Address, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";

/** The chain could not be read, or answered with something that cannot be relied on. */
export class ChainReadError extends Error {}

export type Retention = {
  latestLedger: number;
  oldestLedger: number;
  /** Unix seconds, as text, as the RPC sends them. */
  latestLedgerCloseTime: string;
  oldestLedgerCloseTime: string;
};

export type RawEvent = {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId?: string;
  id: string;
  txHash: string;
  topic?: string[];
  value: string;
  inSuccessfulContractCall?: boolean;
};

export type EventsPage = Retention & { events: RawEvent[]; cursor: string };

export type InstanceCode = { kind: "absent" } | { kind: "wasm"; hash: string } | { kind: "other" };

/** The few RPC calls this module needs, so tests can answer them with recorded data. */
export type ChainReader = {
  health(): Promise<Retention>;
  instance(contract: string): Promise<InstanceCode>;
  events(contract: string, from: { startLedger: number } | { cursor: string }, limit: number): Promise<EventsPage>;
  transaction(hash: string): Promise<{ status: string; ledger: number; createdAt: string }>;
};

/** One payment into the split contract, as it recorded it. */
export type Payment = {
  eventId: string;
  txHash: string;
  ledger: number;
  /** The ledger's close time, ISO with Z. */
  occurredAt: string;
  /** USDC in its smallest unit (7 decimals). */
  units: bigint;
  invoiceRef: string;
  from: string;
};

export type Coverage = {
  fromLedger: number;
  /** Events from this instant on are all included. ISO with Z. */
  from: string;
  toLedger: number;
  /** The close time of the newest ledger scanned. ISO with Z. */
  to: string;
};

/** The contract's `created` event: when its constructor ran. */
export type CreatedEvent = { eventId: string; txHash: string; ledger: number; occurredAt: string };

export type PaymentRead =
  | {
      kind: "read";
      payments: Payment[];
      coverage: Coverage;
      /** Exactly one valid `created` event in the window, or null when there is none (the contract is older than the window). */
      created: CreatedEvent | null;
    }
  | { kind: "no-contract" };

export type SplitExpectation = {
  /** The split contract (C address). */
  contract: string;
  /** The owner the contract must record in each payment: the person's wallet. */
  owner: string;
  /** The USDC token contract the payments must be in. */
  token: string;
  /** The only wasm the contract may run (Caracal's split contract). */
  wasmHash: string;
};

const PAGE_LIMIT = 200;
const MAX_PAGES = 100;
/** Each payment is checked against its transaction; more than this is refused rather than half-checked. */
export const MAX_PAYMENTS = 100;

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Unix seconds (as text) to an ISO instant with Z. */
export function isoFromUnix(s: unknown): string {
  if (typeof s !== "string" || !/^\d{1,11}$/.test(s)) throw new ChainReadError("The RPC sent a time Caracal cannot read.");
  return new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z");
}

function checkRetention(r: Retention): void {
  const ok =
    Number.isSafeInteger(r.latestLedger) &&
    Number.isSafeInteger(r.oldestLedger) &&
    r.oldestLedger > 0 &&
    r.oldestLedger <= r.latestLedger;
  if (!ok) throw new ChainReadError("The RPC sent a ledger range Caracal cannot read.");
  isoFromUnix(r.latestLedgerCloseTime);
  isoFromUnix(r.oldestLedgerCloseTime);
}

/** The ledger a cursor points at (a Stellar TOID keeps the ledger in its upper 32 bits). */
export function cursorLedger(cursor: string): number {
  const m = /^(\d{19})-\d{10}$/.exec(cursor);
  if (!m) throw new ChainReadError("The RPC sent a page cursor Caracal cannot read.");
  const ledger = BigInt(m[1]!) / BigInt(4294967296);
  if (ledger > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainReadError("The RPC sent a page cursor Caracal cannot read.");
  return Number(ledger);
}

const isSym = (v: xdr.ScVal, s: string) => v.switch().name === "scvSymbol" && v.sym().toString() === s;

/** Printable ASCII as is, anything else as 0x-prefixed hex. */
function refText(b: Uint8Array): string {
  const printable = b.length > 0 && b.every((c) => c >= 0x20 && c <= 0x7e);
  return printable ? Buffer.from(b).toString("latin1") : `0x${Buffer.from(b).toString("hex")}`;
}

/**
 * A `split` v1 event's payment, or null for any other kind of event of the
 * contract. A `split` event this reader cannot fully read (another version, a
 * missing field, amounts that do not add up, another token or owner) throws:
 * a payment that cannot be read is never skipped.
 */
export function decodeSplitEvent(e: RawEvent, want: SplitExpectation): Payment | null {
  if (!Array.isArray(e.topic) || e.topic.length === 0) return null;
  const fail = (why: string): never => {
    throw new ChainReadError(`A payment event (${e.id}) ${why}, so no estimate can be made.`);
  };
  let topics: xdr.ScVal[];
  try {
    topics = e.topic.map((t) => xdr.ScVal.fromXDR(t, "base64"));
  } catch {
    // It could be a payment: never skip what cannot be read.
    return fail("could not be read");
  }
  if (!isSym(topics[0]!, "split")) return null;
  if (topics.length !== 2 || !isSym(topics[1]!, "v1")) return fail("is a version of the payment event Caracal does not know");
  let value: unknown;
  try {
    value = scValToNative(xdr.ScVal.fromXDR(e.value, "base64"));
  } catch {
    return fail("could not be read");
  }
  if (typeof value !== "object" || value === null) return fail("has an unexpected shape");
  const { amount, tax, goal, spend, from, owner, token, invoice_ref } = value as Record<string, unknown>;
  if (![amount, tax, goal, spend].every((v) => typeof v === "bigint")) return fail("has amounts Caracal cannot read");
  const [a, t, g, s] = [amount, tax, goal, spend] as bigint[];
  const zero = BigInt(0);
  if (a! <= zero || t! < zero || g! < zero || s! < zero || t! + g! + s! !== a!) return fail("has amounts that do not add up");
  if (typeof from !== "string" || typeof owner !== "string" || typeof token !== "string") return fail("is missing a field");
  if (token !== want.token) return fail("is not in USDC");
  if (owner !== want.owner) return fail("belongs to a different owner than this wallet");
  if (!(invoice_ref instanceof Uint8Array)) return fail("has no invoice reference");
  if (!ISO_Z.test(e.ledgerClosedAt)) return fail("has a time Caracal cannot read");
  return { eventId: e.id, txHash: e.txHash, ledger: e.ledger, occurredAt: e.ledgerClosedAt, units: a!, invoiceRef: refText(invoice_ref), from };
}

/**
 * The contract's `created` v1 event, or null for any other kind of event. A
 * `created` event that cannot be fully read, or that names another owner or
 * token, throws: it is never skipped and never trusted.
 */
export function decodeCreatedEvent(e: RawEvent, want: SplitExpectation): CreatedEvent | null {
  if (!Array.isArray(e.topic) || e.topic.length === 0) return null;
  const fail = (why: string): never => {
    throw new ChainReadError(`The contract's creation event (${e.id}) ${why}, so its creation time cannot be proven and no estimate can be made.`);
  };
  let topics: xdr.ScVal[];
  try {
    topics = e.topic.map((t) => xdr.ScVal.fromXDR(t, "base64"));
  } catch {
    return null; // split events with unreadable topics are refused by decodeSplitEvent
  }
  if (!isSym(topics[0]!, "created")) return null;
  if (topics.length !== 2 || !isSym(topics[1]!, "v1")) return fail("is a version Caracal does not know");
  let value: unknown;
  try {
    value = scValToNative(xdr.ScVal.fromXDR(e.value, "base64"));
  } catch {
    return fail("could not be read");
  }
  if (typeof value !== "object" || value === null) return fail("has an unexpected shape");
  const { owner, token, tax_bps, goal_bps } = value as Record<string, unknown>;
  if (typeof owner !== "string" || typeof token !== "string" || typeof tax_bps !== "number" || typeof goal_bps !== "number") return fail("is missing a field");
  if (owner !== want.owner) return fail("names a different owner than this wallet");
  if (token !== want.token) return fail("is not for USDC");
  if (!ISO_Z.test(e.ledgerClosedAt)) return fail("has a time Caracal cannot read");
  return { eventId: e.id, txHash: e.txHash, ledger: e.ledger, occurredAt: e.ledgerClosedAt };
}

/**
 * Every split payment the RPC still holds for the contract, with the window it
 * proves. Throws ChainReadError when anything cannot be relied on.
 */
export async function readSplitPayments(chain: ChainReader, want: SplitExpectation): Promise<PaymentRead> {
  const health = await chain.health();
  checkRetention(health);

  const code = await chain.instance(want.contract);
  if (code.kind === "absent") return { kind: "no-contract" };
  if (code.kind !== "wasm" || code.hash !== want.wasmHash) {
    throw new ChainReadError("The split contract at this wallet's address does not run Caracal's split code, so its payments cannot be trusted.");
  }

  const startLedger = health.oldestLedger;
  const coverageFrom = isoFromUnix(health.oldestLedgerCloseTime);
  const events: RawEvent[] = [];
  let page = await chain.events(want.contract, { startLedger }, PAGE_LIMIT);
  let last: EventsPage = page;
  for (let n = 1; ; n++) {
    checkRetention(page);
    // History older than the first page's start is not covered; if the RPC's
    // window moved past our start while reading, what was read has a hole.
    if (page.oldestLedger > startLedger) throw new ChainReadError("The RPC's history window moved while Caracal was reading it. Try again.");
    events.push(...page.events);
    last = page;
    const reached = cursorLedger(page.cursor);
    // A cursor past the newest ledger is not a real scan position; believing it would end the scan early.
    if (reached > page.latestLedger) throw new ChainReadError("The RPC sent a page cursor Caracal cannot read.");
    if (reached >= page.latestLedger) break;
    if (n >= MAX_PAGES) throw new ChainReadError("The RPC needed too many pages to read the payments.");
    const next = await chain.events(want.contract, { cursor: page.cursor }, PAGE_LIMIT);
    if (next.cursor === page.cursor) throw new ChainReadError("The RPC stopped moving through the payments.");
    page = next;
  }

  const seen = new Set<string>();
  const payments: Payment[] = [];
  const createdEvents: CreatedEvent[] = [];
  for (const e of events) {
    if (e.type !== "contract" || e.contractId !== want.contract) throw new ChainReadError("The RPC returned an event from another contract.");
    if (!Number.isSafeInteger(e.ledger) || e.ledger < startLedger || e.ledger > last.latestLedger) throw new ChainReadError("The RPC returned an event outside the ledgers asked for.");
    if (typeof e.id !== "string" || seen.has(e.id)) throw new ChainReadError("The RPC returned the same event twice.");
    seen.add(e.id);
    if (e.inSuccessfulContractCall === false) continue;
    const p = decodeSplitEvent(e, want);
    if (p) payments.push(p);
    const c = decodeCreatedEvent(e, want);
    if (c) createdEvents.push(c);
  }
  if (payments.length > MAX_PAYMENTS) throw new ChainReadError(`There are more than ${MAX_PAYMENTS} payments, more than Caracal can check one by one today.`);

  // Each payment's transaction must be a successful one, in the ledger the
  // event names, closed at the time the event names.
  if (createdEvents.length > 1) throw new ChainReadError("The contract has more than one creation event, so its creation time cannot be proven and no estimate can be made.");
  const created = createdEvents[0] ?? null;
  const checked = new Set<string>();
  for (const p of created ? [created, ...payments] : payments) {
    if (checked.has(p.txHash)) continue;
    checked.add(p.txHash);
    const tx = await chain.transaction(p.txHash);
    const closed = Date.parse(p.occurredAt);
    if (tx.status !== "SUCCESS" || tx.ledger !== p.ledger || Number(tx.createdAt) * 1000 !== closed) {
      throw new ChainReadError(`Transaction ${p.txHash} could not be confirmed as a successful transaction in the ledger its event names.`);
    }
  }

  return { kind: "read", payments, created, coverage: { fromLedger: startLedger, from: coverageFrom, toLedger: last.latestLedger, to: isoFromUnix(last.latestLedgerCloseTime) } };
}

// ---- the real RPC ----

type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

const RPC_TIMEOUT_MS = 20_000;

/** A reader over a Soroban JSON-RPC endpoint. */
export function rpcChainReader(url: string, fetchFn: Fetch = fetch as Fetch): ChainReader {
  async function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      body = await res.json();
    } catch {
      throw new ChainReadError("Caracal could not reach the Stellar RPC.");
    }
    const b = body as { result?: unknown; error?: unknown } | null;
    if (!b || typeof b !== "object" || b.error !== undefined || typeof b.result !== "object" || b.result === null) {
      throw new ChainReadError("The Stellar RPC answered with an error or with something Caracal cannot read.");
    }
    return b.result as Record<string, unknown>;
  }

  const retention = (r: Record<string, unknown>): Retention => {
    const { latestLedger, oldestLedger, latestLedgerCloseTime, oldestLedgerCloseTime } = r;
    if (typeof latestLedger !== "number" || typeof oldestLedger !== "number" || typeof latestLedgerCloseTime !== "string" || typeof oldestLedgerCloseTime !== "string") {
      throw new ChainReadError("The Stellar RPC did not say how much history it keeps.");
    }
    return { latestLedger, oldestLedger, latestLedgerCloseTime, oldestLedgerCloseTime };
  };

  return {
    async health() {
      const r = await call("getHealth");
      if (r.status !== "healthy") throw new ChainReadError("The Stellar RPC says it is not healthy.");
      return retention(r);
    },

    async instance(contract) {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(contract).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const keyXdr = key.toXDR("base64");
      const r = await call("getLedgerEntries", { keys: [keyXdr] });
      const entries = r.entries;
      if (entries === null || entries === undefined || (Array.isArray(entries) && entries.length === 0)) return { kind: "absent" };
      if (!Array.isArray(entries) || entries.length !== 1) throw new ChainReadError("The Stellar RPC sent a contract record Caracal cannot read.");
      const entry = entries[0] as { key?: unknown; xdr?: unknown };
      if (entry.key !== keyXdr || typeof entry.xdr !== "string") throw new ChainReadError("The Stellar RPC sent a contract record Caracal cannot read.");
      try {
        const val = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").contractData().val();
        if (val.switch().name !== "scvContractInstance") return { kind: "other" };
        const exe = val.instance().executable();
        return exe.switch().name === "contractExecutableWasm" ? { kind: "wasm", hash: exe.wasmHash().toString("hex") } : { kind: "other" };
      } catch {
        throw new ChainReadError("The Stellar RPC sent a contract record Caracal cannot read.");
      }
    },

    async events(contract, from, limit) {
      const r = await call("getEvents", {
        ...("startLedger" in from ? { startLedger: from.startLedger } : {}),
        filters: [{ type: "contract", contractIds: [contract] }],
        pagination: { ...("cursor" in from ? { cursor: from.cursor } : {}), limit },
      });
      if (!Array.isArray(r.events) || typeof r.cursor !== "string") throw new ChainReadError("The Stellar RPC sent events Caracal cannot read.");
      return { ...retention(r), events: r.events as RawEvent[], cursor: r.cursor };
    },

    async transaction(hash) {
      const r = await call("getTransaction", { hash });
      const ledger = r.ledger;
      if (typeof r.status !== "string" || typeof ledger !== "number" || typeof r.createdAt !== "string") {
        throw new ChainReadError("The Stellar RPC sent a transaction Caracal cannot read.");
      }
      return { status: r.status, ledger, createdAt: r.createdAt };
    },
  };
}

/** A C address that is a valid contract id. */
export const isContractId = (s: unknown): s is string => typeof s === "string" && StrKey.isValidContract(s);
