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
// A record this browser cannot read, or one from an older version of Caracal,
// carries no closeBy, and no ledger seen later proves when its write stopped
// being able to land (Codex split R4 #3). It holds every write until the person
// checks the pots and says so (clearUnknown); nothing is inferred for it.
//
// Rendering never changes the record (Codex split R4 #1). It is written,
// replaced and removed only under this split's Web Lock: by a write starting
// (beginWrite), by a write whose outcome is certain (finish, before it lets go
// of the lock), by clearPassed once an RPC shows a ledger past its closeBy, and
// by clearUnknown. A passed record does not let the page act at once: the pots
// must first be read at a ledger past its closeBy (the page, Codex split R4 #2).
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
/** The ledger the pots shown must be read past, kept after a write's record is gone (adversary s20). */
const READ_AFTER = (split: string) => `caracal.split.readAfter.${split}`;
const LOCK = (split: string) => `caracal.split.write.${split}`;

export type Hold = { held: false } | { held: true; until: number | null; reason: "earlier-write" | "unknown-expiry" | "unreadable" | "unsupported" | "stale" };
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

/**
 * A ledger sequence: Stellar numbers ledgers with a u32, and the kit refuses to sign an expiry beyond it. A saved
 * closeBy outside that range (damaged or odd storage) is no closeBy at all, so its record holds with the person's
 * check as the way past it, not until a ledger the network never reaches (adversary s17).
 */
const isLedger = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 0xffff_ffff;

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

/** Ids of this tab's writes still being sent: their own record does not ask this page to re-read the pots. */
const inFlight = new Set<string>();

/**
 * The closeBy of this split's record, unless it is one of this tab's writes still being sent; null when there is
 * none or it has no closeBy. The page must read the pots at a ledger past it before it offers a write.
 */
export function recordCloseBy(split: string): number | null {
  const s = store();
  if (!s) return null;
  try {
    const rec = read(s, split);
    return rec && !inFlight.has(rec.id) ? rec.closeBy : null;
  } catch {
    return null;
  }
}

/**
 * The ledger the pots shown must be read past because of a write that ended: kept in this browser, so a page
 * opened later (a reload, another tab) still gates its first read, which a lagging RPC node can answer with the pots
 * from before the write (adversary s20). null when none is kept or it cannot be read.
 */
export function readAfter(split: string): number | null {
  const s = store();
  if (!s) return null;
  try {
    const v = JSON.parse(s.getItem(READ_AFTER(split)) ?? "null") as unknown;
    return isLedger(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Keeps `ledger` as the one the pots must be read past, unless a later one is kept already. True when this browser
 * now keeps it (or a later one); false when storage refused it. A record is removed only once this is true, so a
 * refusal leaves the record, whose closeBy still gates every page (Codex split R5 #2).
 */
export function rememberReadAfter(split: string, ledger: number): boolean {
  if (!isLedger(ledger)) return false;
  const s = store();
  if (!s) return false;
  try {
    const kept = readAfter(split);
    if (kept === null || ledger > kept) s.setItem(READ_AFTER(split), JSON.stringify(ledger));
    const now = readAfter(split);
    return now !== null && now >= ledger;
  } catch {
    return false;
  }
}

/** The ledger the pots shown must be read past, from this split's record (recordCloseBy) and from writes that ended (readAfter). */
export function readPastBy(split: string): number | null {
  const a = recordCloseBy(split);
  const b = readAfter(split);
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/**
 * Whether a write on this split must wait, given the latest ledger an RPC showed (null when none was read).
 * Storage that cannot be read holds back. Reads only: it never writes or removes the record.
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
  // Unreadable or from an older version: no ledger proves it can no longer land (see the top).
  if (rec === null) return { held: true, until: null, reason: "unknown-expiry" };
  if (known === null) return { held: true, until: null, reason: "earlier-write" };
  if (known > rec.closeBy) return { held: false };
  return { held: true, until: now + (rec.closeBy - known + 1) * LEDGER_MS, reason: "earlier-write" };
}

/**
 * This tab's writes still holding a split's Web Lock. A write lets go of it once its outcome is certain or its
 * kit call has settled, and also once the network passes its closeBy, since nothing it could still send can land
 * then (adversary s11: a kit call that never settled kept the lock, and every later write was refused with a
 * false reason).
 */
type Live = { closeBy: number; released: boolean; letGo: () => Promise<void> };
const live = new Map<string, Set<Live>>();

/**
 * Lets go of this tab's locks on this split held by writes that are done, or that the network has passed
 * (ledger > closeBy), and resolves once those locks are free.
 */
/** Whether this tab still holds a write's lock on this split (its ledger poll must keep running until it lets go). */
export function holdsWriteLock(split: string): boolean {
  return (live.get(split)?.size ?? 0) > 0;
}

/**
 * Under this split's Web Lock, removes a record the network has passed (ledger > its closeBy), so the page stops
 * reading the ledger for it. Does nothing while a write holds the lock: that write replaces or removes it itself.
 */
export async function clearPassed(split: string, ledger: number, locks: Locks | undefined = browserLocks()): Promise<void> {
  if (!isLedger(ledger)) return;
  await underLock(split, locks, (s) => {
    const rec = read(s, split);
    // Its closeBy still asks a page opened later to read the pots past it (adversary s20). When that cannot be kept,
    // the record stays and gates those pages itself (Codex split R5 #2).
    if (rec && ledger > rec.closeBy && rememberReadAfter(split, rec.closeBy)) s.removeItem(KEY(split));
  });
}

/**
 * Under this split's Web Lock, removes a record with no closeBy (unreadable, or from an older version of Caracal)
 * once the person has checked the pots and said so: the only way past it, since no ledger proves it cannot land.
 * `readPast` (the ledger of the person's check, less one) is kept first as the ledger the pots must be read past;
 * when it cannot be kept, the record stays (Codex split R5 #2). Resolves true when no such record is left.
 */
export async function clearUnknown(split: string, locks: Locks | undefined = browserLocks(), readPast?: number): Promise<boolean> {
  let done = false;
  await underLock(split, locks, (s) => {
    const kept = readPast === undefined || rememberReadAfter(split, readPast);
    const raw = s.getItem(KEY(split));
    if (kept && raw !== null && raw !== undefined && read(s, split) === null) s.removeItem(KEY(split));
    done = kept && (s.getItem(KEY(split)) === null || read(s, split) !== null);
  });
  return done;
}

/** Runs `f` holding this split's Web Lock if it is free at once; does nothing when it is taken or cannot be had. */
async function underLock(split: string, locks: Locks | undefined, f: (s: Store) => void): Promise<void> {
  const s = store();
  if (!s || !locks || typeof locks.request !== "function") return;
  try {
    await locks.request(LOCK(split), { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      try {
        f(s);
      } catch {
        /* storage refused: the record stays, and so does the hold */
      }
    });
  } catch {
    /* the lock could not be had: nothing is changed */
  }
}

export async function passLedger(split: string, ledger: number): Promise<void> {
  const mine = live.get(split);
  if (!mine) return;
  const gone = [...mine].filter((g) => g.released || (isLedger(ledger) && ledger > g.closeBy));
  gone.forEach((g) => mine.delete(g));
  await Promise.all(gone.map((g) => g.letGo()));
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
  /** Set by acquireWrite: settles once this write's Web Lock is free. */
  lockFree?: Promise<unknown>;
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
 * `shownAt` is the ledger the pots on screen were read at (null when the RPC did not say): the write is refused,
 * reason "stale", unless they were read past every ledger this browser keeps for an earlier write, checked here,
 * under the lock, since another tab's write can end between the page's own check and the lock (Codex split R5 #1).
 */
export function beginWrite(split: string, ledger: number, shownAt?: number | null): Begun {
  if (!isLedger(ledger)) return { ok: false, hold: { held: true, until: null, reason: "earlier-write" } };
  const hold = holdOn(split, ledger);
  if (hold.held) return { ok: false, hold };
  const s = store();
  if (!s) return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  try {
    const passed = read(s, split);
    if (shownAt !== undefined) {
      const kept = readAfter(split);
      const need = passed ? (kept === null ? passed.closeBy : Math.max(kept, passed.closeBy)) : kept;
      if (need !== null && !(shownAt !== null && shownAt > need)) return { ok: false, hold: { held: true, until: null, reason: "stale" } };
    }
    // A passed record this write replaces still asks a page opened later to read the pots past its closeBy, as
    // clearPassed keeps it (adversary s21). When that cannot be kept, the record is not replaced (Codex split R5 #2).
    if (passed && !rememberReadAfter(split, passed.closeBy)) return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  } catch {
    return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const closeBy = ledger + WRITE_LEDGERS;
  try {
    write(s, split, { v: 2, id, closeBy });
    // Another tab may have written between the check and this write: only the last writer proceeds.
    if (read(s, split)?.id !== id) return { ok: false, hold: { held: true, until: null, reason: "earlier-write" } };
  } catch {
    return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  }
  inFlight.add(id);
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
  let resolveReleased = () => {};
  const released = new Promise<void>((r) => (resolveReleased = r));
  const entry: Live = {
    closeBy,
    released: false,
    letGo: async () => {
      release();
      await guard.lockFree;
    },
  };
  const release = () => {
    entry.released = true;
    resolveReleased();
  };
  if (!live.has(split)) live.set(split, new Set());
  live.get(split)!.add(entry);
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
        // One whose signers cannot be read is not sent either (adversary s12): a throw here would read as "unknown".
        const needs = (tx as { needsNonInvokerSigningBy?: (o: { includeAlreadySigned: boolean }) => string[] }).needsNonInvokerSigningBy;
        if (typeof needs === "function") {
          let signers: string[];
          try {
            signers = needs.call(tx, { includeAlreadySigned: true });
          } catch {
            return Promise.resolve(UNBOUNDED);
          }
          if (signers.length === 0) return Promise.resolve(UNBOUNDED);
        }
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
      inFlight.delete(id);
      if (outcome.kind === "unknown") {
        unknown = true;
        // Its kit call may never settle: the lock then goes once the network passes closeBy (passLedger).
        if (pending === 0) release();
        return;
      }
      // passLedger let go of this write's lock (the network passed closeBy) before its result came in: nothing is
      // written without the lock, since another tab may be keeping a later read-after ledger right now (Codex split
      // R6). The record, if still this write's, gates every page with closeBy, never earlier than the ledger this
      // result would keep, and clearPassed removes it under the lock, keeping closeBy; a record already replaced or
      // cleared had its closeBy kept under the lock by whoever did so.
      if (entry.released) return;
      // Removed while this write still holds the lock (release lets go of it), so it cannot remove a newer record.
      // A write that went through first keeps the ledger the pots must be read past: the one it landed in less one,
      // or its closeBy when the kit did not say (adversary s19). When that cannot be kept, the record stays, and its
      // closeBy gates a reload or another tab instead (Codex split R5 #2).
      try {
        const keep = outcome.kind !== "done" || rememberReadAfter(split, outcome.ledger !== undefined ? outcome.ledger - 1 : closeBy);
        if (keep && mine()) s.removeItem(KEY(split));
      } catch {
        /* the record stays until the network passes closeBy */
      }
      release();
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
export function acquireWrite(split: string, ledger: number, locks: Locks | undefined = browserLocks(), shownAt?: number | null): Promise<Begun> {
  if (!locks || typeof locks.request !== "function") return Promise.resolve({ ok: false, hold: { held: true, until: null, reason: "unsupported" } });
  // A write of this tab the network has passed holds the lock for nothing: it is let go first.
  return passLedger(split, ledger).then(() => lockAndBegin(split, ledger, locks, shownAt));
}

function lockAndBegin(split: string, ledger: number, locks: Locks, shownAt?: number | null): Promise<Begun> {
  return new Promise((resolve) => {
    let entered = false;
    let answered = false;
    const answer = (r: Begun) => {
      if (answered) return;
      answered = true;
      resolve(r);
    };
    // Settles once the lock request has ended, that is once the lock is free (the guard's lockFree).
    let lockGone = () => {};
    const lockFree = new Promise<void>((r) => (lockGone = r));
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
          begun = beginWrite(split, ledger, shownAt);
        } catch {
          begun = { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
        }
        if (begun.ok) begun.guard.lockFree = lockFree;
        answer(begun);
        if (begun.ok) await begun.guard.released;
      });
      request.then(lockGone, lockGone);
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

/** What the page says while the pots on screen are older than an earlier write it must show (reason "stale"). */
export const STALE_TEXT =
  "Caracal is reading the pots again, and nothing new can be sent until it has read them as of a later ledger, so the pots you see include any earlier withdrawal, move or change that went through. If this stays, press Refresh.";

/** What the page says while a write is held back. */
export function holdText(hold: Held, now: number = Date.now()): string {
  if (hold.reason === "stale") return STALE_TEXT;
  if (hold.reason === "unsupported") {
    return "This browser cannot keep two of its tabs from sending the same withdrawal, so Caracal sends nothing from it. Use an up-to-date browser.";
  }
  if (hold.reason === "unknown-expiry") {
    return "This browser holds a record of an earlier withdrawal, move or change that Caracal cannot read, or one from an older version of Caracal, so it cannot tell whether that write may still go through or when it stops being able to. Check the pots above. If they show it went through, or you are sure it did not, press \"I have checked the pots\" to allow new writes. A repeat of a write that did go through would be sent twice.";
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
