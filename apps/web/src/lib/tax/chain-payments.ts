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

import { Account, Address, Contract, StrKey, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";
import { NETWORK } from "../stellar/config";
import { readLimitedText } from "./read-limited";

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
  /**
   * The events recorded after a cursor the scan ended on, read again after the scan: any event here that the
   * scan did not see means a payment arrived while the read ran. Its newest ledger is the ledger the estimate covers.
   */
  eventsAfter(contract: string, cursor: string, limit: number): Promise<EventsPage>;
  transaction(hash: string): Promise<{ status: string; ledger: number; createdAt: string }>;
  /**
   * What the split contract holds of the token, and the sum of its three pots
   * (tax, goal, spend), both read now, after the covered ledger is fixed, so
   * USDC sent straight to the contract up to that ledger is in `held`. Always
   * checked: USDC held above the pots arrived without a recorded payment.
   * `ledger`: the ledger both reads were made at. Required: a read that cannot say which ledger it saw
   * cannot be shown to be at or after the covered ledger (Codex tax R2 #1).
   */
  holdings(contract: string, token: string): Promise<{ held: bigint; pots: bigint; ledger: number }>;
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
  /** The close time of that ledger: the cutoff. Payments recorded after it are not in the estimate. ISO with Z. */
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
/** How many times the read is repeated when a new event arrives while it runs. */
const MAX_ATTEMPTS = 3;
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

/**
 * Printable ASCII as is, anything else as 0x-prefixed hex. A printable
 * reference that itself reads like that hex form ("0x0102") is shown as hex
 * too, so two different references never give the same text: the text is the
 * payment's key in the duplicate check (pipeline.ts, paymentRef).
 */
function refText(b: Uint8Array): string {
  const ascii = Buffer.from(b).toString("latin1");
  const printable = b.length > 0 && b.every((c) => c >= 0x20 && c <= 0x7e) && !/^0x[0-9a-f]*$/i.test(ascii);
  return printable ? ascii : `0x${Buffer.from(b).toString("hex")}`;
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

/** True for the contract's `reconciled` event, whatever its version or content. */
function isReconciledEvent(e: RawEvent): boolean {
  if (!Array.isArray(e.topic) || e.topic.length === 0) return false;
  try {
    return isSym(xdr.ScVal.fromXDR(e.topic[0]!, "base64"), "reconciled");
  } catch {
    return false;
  }
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
  const first = await chain.health();
  checkRetention(first);

  const code = await chain.instance(want.contract);
  if (code.kind === "absent") return { kind: "no-contract" };
  if (code.kind !== "wasm" || code.hash !== want.wasmHash) {
    throw new ChainReadError("The split contract at this wallet's address does not run Caracal's split code, so its payments cannot be trusted.");
  }

  // The estimate states one ledger it covers. A payment can land after the events were read, so the events
  // are asked for again from where the scan ended: only when nothing new arrived is the scan a stable boundary,
  // and the RPC's newest ledger then is the covered ledger. Otherwise the whole read is repeated, a bounded
  // number of times, and then refused. USDC sent straight to the contract records no event, so the holdings
  // are read only after that ledger is fixed (adversary t8), at that ledger or later: then the events and the
  // holdings agree up to it. The events are read once more after the holdings, so a payment recorded while
  // they were read is in the result, not left out (Codex tax R1 #3).
  let attempt = 0;
  let health = first;
  for (;;) {
    attempt++;
    if (attempt > 1) {
      health = await chain.health();
      checkRetention(health);
    }
    const scanned = await scanEvents(chain, want, health);
    const decoded = decodeScan(scanned, want, health.oldestLedger);
    const tail = await chain.eventsAfter(want.contract, scanned.cursor, PAGE_LIMIT);
    checkRetention(tail);
    if (tail.latestLedger < scanned.last.latestLedger) throw new ChainReadError("The RPC's newest ledger went backwards while Caracal was reading it. Try again.");
    const seenIds = new Set(scanned.events.map((e) => e.id));
    const kept = () => {
      if (attempt >= MAX_ATTEMPTS) throw new ChainReadError("New events kept arriving in the split contract while Caracal was reading it, so it could not fix the ledger the estimate covers. Try again.");
    };
    if (tail.events.some((e) => !seenIds.has(e.id))) {
      kept();
      continue;
    }
    // USDC held above the pots arrived without a recorded payment and has not been reconciled yet.
    const { held, pots, ledger } = await chain.holdings(want.contract, want.token);
    if (!Number.isSafeInteger(ledger)) {
      throw new ChainReadError("The Stellar RPC did not say which ledger it read the split contract's USDC at, so Caracal cannot tell whether it agrees with the payments. Try again.");
    }
    if (ledger < tail.latestLedger) {
      throw new ChainReadError("The Stellar RPC read the split contract's USDC at an older ledger than its payments, so Caracal cannot tell whether they agree. Try again.");
    }
    if (held > pots) {
      throw new ChainReadError(
        "The split contract holds more USDC than its tax, goal and spend pots add up to, so some USDC arrived that was never recorded as a payment (it was sent straight to the contract and not reconciled). Caracal cannot tell what that USDC was, so it cannot show a tax estimate.",
      );
    }
    const after = await chain.eventsAfter(want.contract, scanned.cursor, PAGE_LIMIT);
    checkRetention(after);
    if (after.latestLedger < tail.latestLedger) throw new ChainReadError("The RPC's newest ledger went backwards while Caracal was reading it. Try again.");
    if (after.events.some((e) => !seenIds.has(e.id))) {
      kept();
      continue;
    }
    return finish(chain, want, health, decoded, { toLedger: tail.latestLedger, to: isoFromUnix(tail.latestLedgerCloseTime) });
  }
}

/** How many times the holdings pair is read before two reads at different ledgers are refused. */
const HOLDINGS_ATTEMPTS = 3;

type Scanned = { events: RawEvent[]; last: EventsPage; cursor: string };

/** Reads the contract's events from the oldest retained ledger to the newest, page by page. */
async function scanEvents(chain: ChainReader, want: SplitExpectation, health: Retention): Promise<Scanned> {
  const startLedger = health.oldestLedger;
  const events: RawEvent[] = [];
  let page = await chain.events(want.contract, { startLedger }, PAGE_LIMIT);
  let last: EventsPage = page;
  // The ledger the scan has read up to. The RPC's window moves forward a ledger at a time while the pages
  // are read; that loses nothing unless it moves past this point (on the first page, past the start).
  let readTo = startLedger;
  for (let n = 1; ; n++) {
    checkRetention(page);
    if (page.oldestLedger > readTo) throw new ChainReadError("The RPC's history window moved while Caracal was reading it. Try again.");
    events.push(...page.events);
    last = page;
    const reached = cursorLedger(page.cursor);
    // A cursor past the newest ledger is not a real scan position; believing it would end the scan early.
    if (reached > page.latestLedger) throw new ChainReadError("The RPC sent a page cursor Caracal cannot read.");
    readTo = reached;
    // A full page that stops inside the newest ledger may leave events of that ledger unread: ask again.
    const full = page.events.length >= PAGE_LIMIT;
    if (reached >= page.latestLedger && !full) break;
    if (n >= MAX_PAGES) throw new ChainReadError("The RPC needed too many pages to read the payments.");
    const next = await chain.events(want.contract, { cursor: page.cursor }, PAGE_LIMIT);
    if (next.cursor === page.cursor) {
      // Nothing after a full page that already reached the newest ledger: the scan is complete.
      if (reached >= page.latestLedger && next.events.length === 0) {
        checkRetention(next);
        if (next.oldestLedger > readTo) throw new ChainReadError("The RPC's history window moved while Caracal was reading it. Try again.");
        last = next;
        break;
      }
      throw new ChainReadError("The RPC stopped moving through the payments.");
    }
    page = next;
  }
  return { events, last, cursor: last.cursor };
}

type Decoded = { payments: Payment[]; createdEvents: CreatedEvent[] };

function decodeScan(scan: Scanned, want: SplitExpectation, startLedger: number): Decoded {
  const { events, last } = scan;
  const seen = new Set<string>();
  const payments: Payment[] = [];
  const createdEvents: CreatedEvent[] = [];
  let reconciledId: string | null = null;
  for (const e of events) {
    if (e.type !== "contract" || e.contractId !== want.contract) throw new ChainReadError("The RPC returned an event from another contract.");
    if (!Number.isSafeInteger(e.ledger) || e.ledger < startLedger || e.ledger > last.latestLedger) throw new ChainReadError("The RPC returned an event outside the ledgers asked for.");
    if (typeof e.id !== "string" || seen.has(e.id)) throw new ChainReadError("The RPC returned the same event twice.");
    seen.add(e.id);
    if (e.inSuccessfulContractCall === false) continue;
    if (isReconciledEvent(e)) reconciledId ??= e.id;
    const p = decodeSplitEvent(e, want);
    if (p) payments.push(p);
    const c = decodeCreatedEvent(e, want);
    if (c) createdEvents.push(c);
  }
  // reconcile() credits USDC that was sent straight to the contract. Caracal cannot tell what that USDC was
  // (income, a transfer from the owner, a refund), so a number that leaves it out or counts it would be a guess.
  if (reconciledId !== null) {
    throw new ChainReadError(
      `The split contract credited USDC that was sent to it directly (a "reconciled" event, ${reconciledId}). Caracal cannot tell what that USDC was, so it cannot show a tax estimate from this wallet's payments.`,
    );
  }
  return { payments, createdEvents };
}

async function finish(chain: ChainReader, want: SplitExpectation, health: Retention, d: Decoded, boundary: { toLedger: number; to: string }): Promise<PaymentRead> {
  const { payments, createdEvents } = d;
  if (payments.length > MAX_PAYMENTS) throw new ChainReadError(`There are more than ${MAX_PAYMENTS} payments, more than Caracal can check one by one today.`);

  // Each payment's transaction must be a successful one, in the ledger the
  // event names, closed at the time the event names.
  if (createdEvents.length > 1) throw new ChainReadError("The contract has more than one creation event, so its creation time cannot be proven and no estimate can be made.");
  const created = createdEvents[0] ?? null;
  // Every event is compared, not only the first of each transaction: two
  // events of one transaction must both name its ledger and close time.
  const txOf = new Map<string, Awaited<ReturnType<typeof chain.transaction>>>();
  for (const p of created ? [created, ...payments] : payments) {
    let tx = txOf.get(p.txHash);
    if (!tx) {
      tx = await chain.transaction(p.txHash);
      txOf.set(p.txHash, tx);
    }
    const closed = Date.parse(p.occurredAt);
    if (tx.status !== "SUCCESS" || tx.ledger !== p.ledger || Number(tx.createdAt) * 1000 !== closed) {
      throw new ChainReadError(`Transaction ${p.txHash} could not be confirmed as a successful transaction in the ledger its event names.`);
    }
  }

  return { kind: "read", payments, created, coverage: { fromLedger: health.oldestLedger, from: isoFromUnix(health.oldestLedgerCloseTime), toLedger: boundary.toLedger, to: boundary.to } };
}

// ---- the real RPC ----

type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

const RPC_TIMEOUT_MS = 20_000;
/** Largest RPC answer read (a page of 200 events is well under this). The download stops past it. */
const MAX_RPC_BODY_BYTES = 10_000_000;

/** A reader over a Soroban JSON-RPC endpoint. */
export function rpcChainReader(url: string, fetchFn: Fetch = fetch as Fetch, passphrase: string = NETWORK.passphrase): ChainReader {
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
      const text = await readLimitedText(res, MAX_RPC_BODY_BYTES);
      if (text === null) throw new Error("answer too large");
      body = JSON.parse(text);
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

  /** A read-only contract call, simulated. The source account is a placeholder: a simulation does not need it to exist. */
  async function simulateRead(contract: string, fn: string, args: xdr.ScVal[]): Promise<{ value: unknown; ledger: number }> {
    const source = new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32)), "0");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase }).addOperation(new Contract(contract).call(fn, ...args)).setTimeout(30).build();
    const r = await call("simulateTransaction", { transaction: tx.toXDR() });
    const results = r.results;
    if (r.error !== undefined || !Array.isArray(results) || results.length !== 1) throw new ChainReadError("The Stellar RPC could not read the split contract's USDC.");
    const out = (results[0] as { xdr?: unknown } | null)?.xdr;
    if (typeof out !== "string") throw new ChainReadError("The Stellar RPC could not read the split contract's USDC.");
    // The ledger it was read at (a simulation answer names it): the caller checks it is not older than the
    // ledger the estimate covers. An answer without one cannot be checked, so it is refused (Codex tax R2 #1).
    const ledger = r.latestLedger;
    if (typeof ledger !== "number" || !Number.isSafeInteger(ledger) || ledger <= 0) {
      throw new ChainReadError("The Stellar RPC did not say which ledger it read the split contract's USDC at, so Caracal cannot tell whether it agrees with the payments. Try again.");
    }
    try {
      return { value: scValToNative(xdr.ScVal.fromXDR(out, "base64")), ledger };
    } catch {
      throw new ChainReadError("The Stellar RPC could not read the split contract's USDC.");
    }
  }

  async function getEvents(contract: string, from: { startLedger: number } | { cursor: string }, limit: number): Promise<EventsPage> {
    const r = await call("getEvents", {
      ...("startLedger" in from ? { startLedger: from.startLedger } : {}),
      filters: [{ type: "contract", contractIds: [contract] }],
      pagination: { ...("cursor" in from ? { cursor: from.cursor } : {}), limit },
    });
    if (!Array.isArray(r.events) || typeof r.cursor !== "string") throw new ChainReadError("The Stellar RPC sent events Caracal cannot read.");
    return { ...retention(r), events: r.events as RawEvent[], cursor: r.cursor };
  }

  return {
    async holdings(contract, token) {
      // The balance and the pots are two simulations. Read at different ledgers they can disagree with no
      // unrecorded USDC at any one ledger (a withdrawal between them: adversary t9), so the pair is read
      // again until both name the same ledger, a bounded number of times.
      for (let attempt = 1; ; attempt++) {
        const a = await simulateRead(token, "balance", [Address.fromString(contract).toScVal()]);
        const b = await simulateRead(contract, "balances", []);
        const held = a.value;
        const pots = b.value;
        if (typeof held !== "bigint" || !Array.isArray(pots) || pots.length !== 3 || !pots.every((x) => typeof x === "bigint")) {
          throw new ChainReadError("The Stellar RPC sent the split contract's USDC in a form Caracal cannot read.");
        }
        if (a.ledger !== b.ledger) {
          if (attempt >= HOLDINGS_ATTEMPTS) throw new ChainReadError("The Stellar RPC kept reading the split contract's USDC and its pots at different ledgers, so Caracal cannot tell whether they agree. Try again.");
          continue;
        }
        return { held, pots: (pots as bigint[]).reduce((x, y) => x + y, BigInt(0)), ledger: a.ledger };
      }
    },

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

    events: getEvents,
    eventsAfter: (contract, cursor, limit) => getEvents(contract, { cursor }, limit),

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
