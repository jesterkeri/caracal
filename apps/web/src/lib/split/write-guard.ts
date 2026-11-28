// Holding back a second write while an earlier one may still land.
//
// sendSplitCall stops waiting after SEND_TIMEOUT_MS, but that does not cancel
// the kit's signAndSubmit: the first write can still be posted to the relay and
// confirmed. A person who signed the same withdrawal again could then have both
// land. So every write leaves a record in localStorage BEFORE anything is sent,
// and no write of any kind on this split starts while the record says the
// earlier one can still land. The record is removed only when the outcome is
// certain (done, refused, stopped).
//
// When can an uncertain write no longer land? Not "some minutes later": a
// browser clock can jump forward, and time read from it proves nothing (Codex
// split R3). Each write fixes its own last ledger, closeBy, before it is sent:
// the page reads the latest ledger, and the passkey signs the wallet's
// authorisation to expire at closeBy (the kit's `expiration`, the auth entry's
// signatureExpirationLedger). The network refuses that authorisation in any
// ledger after closeBy, so once an RPC shows a ledger past it, the write can no
// longer land, whatever any clock says. An RPC can lag the network but never run
// ahead of it, so its ledger is a safe lower bound. Without a ledger read, the
// hold stays.
//
// A record this browser cannot read, or one from an older version of Caracal
// (which signed with the kit's default expiry, at most KIT_DEFAULT_LEDGERS after
// the ledger it read), is given closeBy = the ledger read now + KIT_DEFAULT_LEDGERS,
// which is past any such write's expiry.
//
// Storage that cannot be read holds back; storage that cannot be written
// refuses to start a write, because nothing would stop a repeat.
//
// Checking the record and writing it are two steps, so two tabs could both
// see none and both start (Codex split R2 #1). acquireWrite takes this
// split's Web Lock first, which is atomic across the tabs of one site, and
// holds it for as long as the write may still be sent from this tab; the
// browser lets it go if the tab dies.

import type { contract } from "@stellar/stellar-sdk";
import type { TransactionResult } from "smart-account-kit";
import { browserLocks, type Locks } from "@/lib/auth/creation-lock";
import { READ_TIMEOUT_MS } from "./chain";
import type { SendOutcome, WriteKit } from "./send";

/** How many ledgers after the one read before a write its passkey signature stays valid (about 5 minutes). */
export const WRITE_LEDGERS = 60;
/** smart-account-kit 0.10.0's default signature expiry, used by writes from older versions of Caracal. */
export const KIT_DEFAULT_LEDGERS = 720;
/** About how long a testnet ledger takes, only to say roughly how long a hold lasts. */
const LEDGER_MS = 5_000;
const KEY = (split: string) => `caracal.split.write.${split}`;
const LOCK = (split: string) => `caracal.split.write.${split}`;

export type Hold = { held: false } | { held: true; until: number | null; reason: "earlier-write" | "unreadable" | "unsupported" };
type Held = Extract<Hold, { held: true }>;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Rec = { v: 2; id: string; closeBy: number };

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

const isLedger = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** The record for this split: undefined when none, null when it is there but cannot be read (or has no closeBy). */
function read(s: Store, split: string): Rec | null | undefined {
  const raw = s.getItem(KEY(split));
  if (raw === null || raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<Rec> | null;
    return v?.v === 2 && typeof v.id === "string" && isLedger(v.closeBy) ? { v: 2, id: v.id, closeBy: v.closeBy } : null;
  } catch {
    return null;
  }
}

const write = (s: Store, split: string, r: Rec) => s.setItem(KEY(split), JSON.stringify(r));

/** Whether this browser holds a write record for this split (the page then reads the ledger to see if it has passed). */
export function hasWriteRecord(split: string): boolean {
  const s = store();
  if (!s) return true;
  try {
    return s.getItem(KEY(split)) !== null;
  } catch {
    return true;
  }
}

/**
 * Whether a write on this split must wait, given the latest ledger an RPC showed (null when none was read).
 * Storage that cannot be read holds back.
 */
export function holdOn(split: string, ledger: number | null, now: number = Date.now()): Hold {
  const s = store();
  if (!s) return { held: true, until: null, reason: "unreadable" };
  let rec: Rec | null | undefined;
  try {
    rec = read(s, split);
  } catch {
    return { held: true, until: null, reason: "unreadable" };
  }
  if (rec === undefined) return { held: false };
  const known = isLedger(ledger) ? ledger : null;
  if (rec === null) {
    // Unreadable or from an older version: bounded from the first ledger it is seen at (see the top).
    if (known === null) return { held: true, until: null, reason: "earlier-write" };
    try {
      write(s, split, { v: 2, id: "earlier", closeBy: known + KIT_DEFAULT_LEDGERS });
    } catch {
      return { held: true, until: null, reason: "unreadable" };
    }
    return { held: true, until: now + (KIT_DEFAULT_LEDGERS + 1) * LEDGER_MS, reason: "earlier-write" };
  }
  if (known === null) return { held: true, until: null, reason: "earlier-write" };
  if (known > rec.closeBy) return { held: false };
  return { held: true, until: now + (rec.closeBy - known + 1) * LEDGER_MS, reason: "earlier-write" };
}

export type WriteGuard = {
  /** The kit, with its signAndSubmit bound to this write's closeBy and watched until it settles. */
  kit(k: WriteKit): WriteKit;
  /** The outcome: certain ones remove the record; an unknown one keeps it until the network passes closeBy. */
  finish(outcome: SendOutcome): void;
  /** Settles once nothing more can be sent from this tab: a certain outcome, or an unknown one whose kit call has settled. */
  released: Promise<void>;
  /** The last ledger this write can land in. */
  closeBy: number;
};

type Begun = { ok: true; guard: WriteGuard } | { ok: false; hold: Held };

/** The refusal the guarded kit gives for a transaction it cannot bound: nothing is signed or sent. */
const UNBOUNDED: TransactionResult = {
  success: false,
  error: Object.assign(new Error("This call carries no authorisation for your wallet to sign, so Caracal could not give it a last ledger. Nothing was sent."), { code: 5002 }) as never,
};

/**
 * Takes the hold on this split before anything is sent, given the latest ledger read just now: refused when
 * an earlier write holds it. The write's closeBy is that ledger + WRITE_LEDGERS, recorded before sending.
 */
export function beginWrite(split: string, ledger: number): Begun {
  if (!isLedger(ledger)) return { ok: false, hold: { held: true, until: null, reason: "earlier-write" } };
  const hold = holdOn(split, ledger);
  if (hold.held) return { ok: false, hold };
  const s = store();
  if (!s) return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const closeBy = ledger + WRITE_LEDGERS;
  try {
    write(s, split, { v: 2, id, closeBy });
    // Another tab may have written between the check and this write: only the last writer proceeds.
    if (read(s, split)?.id !== id) return { ok: false, hold: { held: true, until: null, reason: "earlier-write" } };
  } catch {
    return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  }
  const mine = () => {
    try {
      return read(s, split)?.id === id;
    } catch {
      return false;
    }
  };
  let pending = 0;
  let unknown = false;
  let restore = () => {};
  let release = () => {};
  const released = new Promise<void>((r) => (release = r));
  const settled = () => {
    pending--;
    if (unknown && pending === 0) release();
  };
  const guard: WriteGuard = {
    released,
    closeBy,
    kit(k) {
      // The same kit object goes on (one write runs at a time), with its signAndSubmit bound until finish().
      const original = k.signAndSubmit;
      if (typeof original !== "function") return k;
      k.signAndSubmit = (tx: contract.AssembledTransaction<unknown>, options?: { expiration?: number }) => {
        // closeBy bounds the write only through a signature the wallet gives: a call that needs none is not sent.
        const needs = (tx as { needsNonInvokerSigningBy?: (o: { includeAlreadySigned: boolean }) => string[] }).needsNonInvokerSigningBy;
        if (typeof needs === "function" && needs.call(tx, { includeAlreadySigned: true }).length === 0) return Promise.resolve(UNBOUNDED);
        pending++;
        const p = original.call(k, tx, { ...options, expiration: closeBy });
        Promise.resolve(p).then(settled, settled);
        return p;
      };
      restore = () => {
        if (k.signAndSubmit !== original) k.signAndSubmit = original;
      };
      return k;
    },
    finish(outcome) {
      restore();
      if (outcome.kind === "unknown") {
        unknown = true;
        if (pending === 0) release();
        return;
      }
      release();
      try {
        if (mine()) s.removeItem(KEY(split));
      } catch {
        /* the record stays until the network passes closeBy */
      }
    },
  };
  return { ok: true, guard };
}

/**
 * beginWrite under this split's Web Lock, held until the guard is released, so no other tab of this
 * browser can check and write the record at the same time (Codex split R2 #1). Does not wait for the
 * lock: a tab that holds it is writing, so this write is held back. Without Web Locks, or when the
 * browser refuses the request (blocked site data, a sandboxed frame), nothing is sent.
 */
export function acquireWrite(split: string, ledger: number, locks: Locks | undefined = browserLocks()): Promise<Begun> {
  if (!locks || typeof locks.request !== "function") return Promise.resolve({ ok: false, hold: { held: true, until: null, reason: "unsupported" } });
  return new Promise((resolve) => {
    let entered = false;
    let answered = false;
    const answer = (r: Begun) => {
      if (answered) return;
      answered = true;
      resolve(r);
    };
    let request: Promise<unknown>;
    try {
      request = locks.request(LOCK(split), { ifAvailable: true }, async (lock) => {
        entered = true;
        if (!lock) {
          const h = holdOn(split, ledger);
          return answer({ ok: false, hold: h.held ? h : { held: true, until: null, reason: "earlier-write" } });
        }
        let begun: Begun;
        try {
          begun = beginWrite(split, ledger);
        } catch {
          begun = { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
        }
        answer(begun);
        if (begun.ok) await begun.guard.released;
      });
    } catch {
      return answer({ ok: false, hold: { held: true, until: null, reason: "unreadable" } });
    }
    request.catch(() => {
      if (!entered) answer({ ok: false, hold: { held: true, until: null, reason: "unreadable" } });
    });
  });
}

/** The latest ledger the RPC shows, within the usual read limit; throws when it cannot be read. */
export async function readLedger(rpc: unknown): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      (rpc as { getLatestLedger(): Promise<{ sequence?: unknown }> }).getLatestLedger(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the Stellar network did not answer within ${READ_TIMEOUT_MS / 1000} seconds`)), READ_TIMEOUT_MS);
      }),
    ]);
    if (!isLedger(r?.sequence)) throw new Error("the Stellar network did not say which ledger it is at");
    return r.sequence;
  } finally {
    clearTimeout(timer);
  }
}

/** What the page says while a write is held back. */
export function holdText(hold: Held, now: number = Date.now()): string {
  if (hold.reason === "unsupported") {
    return "This browser cannot keep two of its tabs from sending the same withdrawal, so Caracal sends nothing from it. Use an up-to-date browser.";
  }
  if (hold.reason === "unreadable") {
    return "Caracal cannot tell whether an earlier withdrawal or move is still on its way, because this browser would not let it check. Nothing can be sent from here until it can. Refresh the pots, and allow this site to store data.";
  }
  if (hold.until === null) {
    return "An earlier withdrawal, move or change may still go through. Check the pots above before you repeat it. To keep you from sending it twice, nothing new can be sent until Caracal reads on the Stellar network that it can no longer land; it checks every few seconds.";
  }
  const mins = Math.max(1, Math.ceil((hold.until - now) / 60_000));
  return `An earlier withdrawal, move or change may still go through. Check the pots above before you repeat it. To keep you from sending it twice, nothing new can be sent for about ${mins} ${mins === 1 ? "minute" : "minutes"}, until the network passes the last ledger it could land in.`;
}
