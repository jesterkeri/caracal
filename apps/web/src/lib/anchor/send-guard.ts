// Holding back a new cash-out while an earlier USDC payment from this browser may still land.
//
// The page's own locks (sendingFor, unknownSend, the landing window) live in its memory, so a reload, a
// crash, leaving the page, or the reload another tab's account change causes, used to reset it to a fresh
// cash-out while the first payment could still land: the person could then pay a second time (Codex
// cash-out R1 #1). So every payment leaves a record in localStorage BEFORE the passkey is asked, and no
// cash-out of this wallet starts or sends while the record says it can still land. The record is removed
// only when the outcome is certain: confirmed sent, proven not sent, or reported by the anchor as completed
// or refunded (it received the payment).
//
// When can an uncertain payment no longer land? Not "some minutes later": a browser clock can jump, and time
// read from it proves nothing (the same finding as Codex split R3). Each payment fixes its own last ledger,
// closeBy, before it is sent: the page reads the latest ledger, and the passkey signs the wallet's
// authorisation to expire at closeBy (the kit's `expiration`). The network refuses that authorisation in any
// ledger after closeBy, so once an RPC shows a ledger past it, the payment can no longer land, whatever any
// clock says. An RPC can lag the network but never run ahead of it. Without a ledger read, the hold stays.
//
// A record this browser cannot read, or one from the older, clock-based version, carries no closeBy, and no
// ledger seen later proves when its payment stopped being able to land (ported from Codex split R4 #3). It
// holds every cash-out until the person checks their USDC balance and says so (clearUnknown).
//
// Rendering never changes the record (ported from Codex split R4 #1): it is written, replaced and removed only
// under this wallet's Web Lock, by beginSend, by finish on a certain outcome (before the payment lets go of the
// lock), by anchorReceived and by clearUnknown. A passed record does not let the page offer a cash-out at once:
// the balance must first be read at a ledger past its closeBy (the page, ported from Codex split R4 #2).
//
// Checking the record and writing it are two steps, so acquireSend takes this wallet's Web Lock first
// (atomic across the tabs of one site) and holds it while the payment may still be sent from this tab; the
// browser lets it go if the tab dies. Storage that cannot be read holds back; storage that cannot be written,
// or a browser without Web Locks, refuses to send, because nothing would stop a repeat.

import type { contract } from "@stellar/stellar-sdk";
import { browserLocks, type Locks } from "@/lib/auth/creation-lock";

/**
 * How many ledgers after the one read at Send the passkey signature stays valid: about 90 s, which covers the
 * kit's passkey prompt (WEBAUTHN_TIMEOUT_MS, 60 s) and the relay's transaction validity (TX_TIMEOUT_S, 25 s),
 * and matches the page's landing window. A signature that expires first only makes the payment fail.
 */
export const SEND_LEDGERS = 18;
/** smart-account-kit 0.10.0's default signature expiry, used by payments from older versions of Caracal. */
export const KIT_DEFAULT_LEDGERS = 720;
/** About how long a testnet ledger takes, only to say roughly how long a hold lasts. */
const LEDGER_MS = 5_000;
/** How long a ledger read may take before it counts as failed. */
const LEDGER_READ_MS = 15_000;
const KEY = (wallet: string) => `caracal.cashout.send.${wallet}`;
const LOCK = (wallet: string) => `caracal.cashout.send.${wallet}`;

/** The anchor's transaction id and the payment's hash, when known: shown so the person can follow it up. */
export type Earlier = { anchorId: string | null; hash: string | null };
export type Hold =
  | { held: false }
  | { held: true; until: number | null; reason: "earlier-send"; earlier: Earlier }
  | { held: true; until: null; reason: "unknown-expiry"; earlier: Earlier }
  | { held: true; until: null; reason: "unreadable" | "unsupported" | "busy" };
type Held = Extract<Hold, { held: true }>;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Rec = { v: 2; id: string; closeBy: number; anchorId: string | null; hash: string | null };

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
/**
 * A ledger sequence: Stellar numbers ledgers with a u32, and the kit refuses to sign an expiry beyond it. A saved
 * closeBy outside that range (damaged or odd storage) is no closeBy at all, so its record holds with the person's
 * check as the way past it, not until a ledger the network never reaches (adversary s17).
 */
const isLedger = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 0xffff_ffff;

/** The record for this wallet: undefined when none, null when it is there but cannot be read (or has no closeBy). */
function read(s: Store, wallet: string): Rec | null | undefined {
  const raw = s.getItem(KEY(wallet));
  if (raw === null || raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (v?.v !== 2 || typeof v.id !== "string" || !isLedger(v.closeBy)) return null;
    return { v: 2, id: v.id, closeBy: v.closeBy, anchorId: text(v.anchorId), hash: text(v.hash) };
  } catch {
    return null;
  }
}

/** What an older or unreadable record still tells: the anchor id and hash, when it names them. */
function earlierOf(s: Store, wallet: string): Earlier {
  try {
    const v = JSON.parse(s.getItem(KEY(wallet)) ?? "null") as Record<string, unknown> | null;
    return { anchorId: text(v?.anchorId), hash: text(v?.hash) };
  } catch {
    return { anchorId: null, hash: null };
  }
}

const write = (s: Store, wallet: string, r: Rec) => s.setItem(KEY(wallet), JSON.stringify(r));

/**
 * The closeBy of this wallet's record, whoever's it is; null when there is none or it has no closeBy. The page must
 * read the balance at a ledger past it before it offers a cash-out. This tab's own payment still being sent counts
 * too (adversary c35): the page that sends it offers nothing meanwhile, and a copy of the page mounted again while it
 * is sent must not offer a cash-out on a balance read before it landed. A certain outcome removes the record.
 */
export function recordCloseBy(wallet: string): number | null {
  const s = store();
  if (!s) return null;
  try {
    const rec = read(s, wallet);
    return rec ? rec.closeBy : null;
  } catch {
    return null;
  }
}

/**
 * Whether a cash-out of this wallet must wait, given the latest ledger an RPC showed (null when none was read).
 * Storage that cannot be read holds back. Reads only: it never writes or removes the record.
 */
export function sendHold(wallet: string, ledger: number | null, now: number = Date.now()): Hold {
  const s = store();
  if (!s) return { held: true, until: null, reason: "unreadable" };
  let rec: Rec | null | undefined;
  try {
    rec = read(s, wallet);
  } catch {
    return { held: true, until: null, reason: "unreadable" };
  }
  if (rec === undefined) return { held: false };
  const known = isLedger(ledger) ? ledger : null;
  // Unreadable or from an older version: no ledger proves it can no longer land (see the top).
  if (rec === null) return { held: true, until: null, reason: "unknown-expiry", earlier: earlierOf(s, wallet) };
  const earlier = { anchorId: rec.anchorId, hash: rec.hash };
  if (known === null) return { held: true, until: null, reason: "earlier-send", earlier };
  if (known > rec.closeBy) return { held: false };
  return { held: true, until: now + (rec.closeBy - known + 1) * LEDGER_MS, reason: "earlier-send", earlier };
}

/**
 * The anchor reported this withdrawal completed or refunded, so it received the payment: the outcome is
 * certain, and a record for that withdrawal is removed, under the wallet's Web Lock (never while a payment of
 * any tab holds it, so it cannot remove a newer record).
 */
export function anchorReceived(wallet: string, anchorId: string, locks: Locks | undefined = browserLocks()): Promise<void> {
  return underLock(wallet, locks, (s) => {
    if (read(s, wallet)?.anchorId === anchorId) s.removeItem(KEY(wallet));
  });
}

/**
 * Under this wallet's Web Lock, removes a record with no closeBy (unreadable, or from an older version of Caracal)
 * once the person has checked their balance and said so: the only way past it, since no ledger proves it cannot
 * land. Resolves true when no such record is left.
 */
export async function clearUnknown(wallet: string, locks: Locks | undefined = browserLocks()): Promise<boolean> {
  let done = false;
  await underLock(wallet, locks, (s) => {
    const raw = s.getItem(KEY(wallet));
    if (raw !== null && raw !== undefined && read(s, wallet) === null) s.removeItem(KEY(wallet));
    done = s.getItem(KEY(wallet)) === null || read(s, wallet) !== null;
  });
  return done;
}

/** Runs `f` holding this wallet's Web Lock if it is free at once; does nothing when it is taken or cannot be had. */
async function underLock(wallet: string, locks: Locks | undefined, f: (s: Store) => void): Promise<void> {
  const s = store();
  if (!s || !locks || typeof locks.request !== "function") return;
  try {
    await locks.request(LOCK(wallet), { ifAvailable: true }, async (lock) => {
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

/** The part of the kit a payment is sent with. */
export type Submitter<R> = { signAndSubmit(tx: contract.AssembledTransaction<unknown>, options: { expiration: number }): Promise<R> };

export type SendGuard = {
  /** The last ledger this payment can land in. */
  closeBy: number;
  /**
   * Sends through the kit with the passkey signature expiring at closeBy, watched until it settles. A
   * transaction that needs no signature from the wallet is not sent: closeBy bounds a payment only through it.
   */
  submit<R>(kit: Submitter<R>, tx: contract.AssembledTransaction<unknown>): Promise<R>;
  /** The payment's hash once known, kept in the record so a reloaded page can show it. */
  noteHash(hash: string): void;
  /** The outcome: a certain one removes the record; an unknown one keeps it until the network passes closeBy. */
  finish(kind: "sent" | "not-sent" | "unknown"): void;
  /** Settles once nothing more can be sent from this tab. */
  released: Promise<void>;
  /** Set by acquireSend: settles once this payment's Web Lock is free. */
  lockFree?: Promise<unknown>;
};

/**
 * This tab's payments still holding a wallet's Web Lock. A payment lets go of it once its outcome is certain or
 * its kit call has settled, and also once the network passes its closeBy, since nothing it could still send can
 * land then (the split guard's adversary s11: a kit call that never settled kept the lock, and every later
 * payment was refused with a false reason).
 */
type Live = { closeBy: number; released: boolean; letGo: () => Promise<void> };
const live = new Map<string, Set<Live>>();

/**
 * Lets go of this tab's locks on this wallet held by payments that are done, or that the network has passed
 * (ledger > closeBy), and resolves once those locks are free.
 */
/** Whether this tab still holds a payment's lock for this wallet (its ledger poll must keep running until it lets go). */
export function holdsSendLock(wallet: string): boolean {
  return (live.get(wallet)?.size ?? 0) > 0;
}

export async function passLedger(wallet: string, ledger: number): Promise<void> {
  const mine = live.get(wallet);
  if (!mine) return;
  const gone = [...mine].filter((g) => g.released || (isLedger(ledger) && ledger > g.closeBy));
  gone.forEach((g) => mine.delete(g));
  await Promise.all(gone.map((g) => g.letGo()));
}

/** What submit throws for a transaction it cannot bound; nothing was signed or sent. */
export class UnboundedPayment extends Error {}

type Begun = { ok: true; guard: SendGuard } | { ok: false; hold: Held };

/**
 * Takes the hold for this wallet before the passkey is asked, given the latest ledger read just now: refused
 * when an earlier payment holds it. The payment's closeBy is that ledger + SEND_LEDGERS, recorded first.
 */
export function beginSend(wallet: string, anchorId: string, ledger: number): Begun {
  const none: Earlier = { anchorId: null, hash: null };
  if (!isLedger(ledger)) return { ok: false, hold: { held: true, until: null, reason: "earlier-send", earlier: none } };
  const hold = sendHold(wallet, ledger);
  if (hold.held) return { ok: false, hold };
  const s = store();
  if (!s) return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const closeBy = ledger + SEND_LEDGERS;
  let hash: string | null = null;
  try {
    write(s, wallet, { v: 2, id, closeBy, anchorId, hash });
    if (read(s, wallet)?.id !== id) return { ok: false, hold: { held: true, until: null, reason: "earlier-send", earlier: none } };
  } catch {
    return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  }
  const mine = () => {
    try {
      return read(s, wallet)?.id === id;
    } catch {
      return false;
    }
  };
  let pending = 0;
  let unknown = false;
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
  if (!live.has(wallet)) live.set(wallet, new Set());
  live.get(wallet)!.add(entry);
  const settled = () => {
    pending--;
    if (unknown && pending === 0) release();
  };
  const guard: SendGuard = {
      closeBy,
      released,
      submit(kit, tx) {
        const needs = (tx as { needsNonInvokerSigningBy?: (o: { includeAlreadySigned: boolean }) => string[] }).needsNonInvokerSigningBy;
        // One whose signers cannot be read is not sent either: a throw here would read as "unknown" (split's adversary s12).
        let signers: string[] | null = null;
        try {
          signers = typeof needs === "function" ? needs.call(tx, { includeAlreadySigned: true }) : null;
        } catch {
          signers = [];
        }
        if (signers !== null && signers.length === 0) {
          return Promise.reject(new UnboundedPayment("This payment carries no authorisation for your wallet to sign, so Caracal could not give it a last ledger. Nothing was sent."));
        }
        pending++;
        const p = kit.signAndSubmit(tx, { expiration: closeBy });
        p.then(settled, settled);
        return p;
      },
      noteHash(h) {
        hash = text(h);
        try {
          if (mine()) write(s, wallet, { v: 2, id, closeBy, anchorId, hash });
        } catch {
          /* the record keeps what it had */
        }
      },
      finish(kind) {
        if (kind === "unknown") {
          unknown = true;
          if (pending === 0) release();
          return;
        }
        // Removed while this payment still holds the lock (release lets go of it), so it cannot remove a newer record.
        try {
          if (mine()) s.removeItem(KEY(wallet));
        } catch {
          /* the record stays until the network passes its closeBy */
        }
        release();
      },
  };
  return { ok: true, guard };
}

/**
 * beginSend under this wallet's Web Lock, held until the guard is released, so no other tab of this browser
 * can check and write the record at the same time. Does not wait for the lock: a tab that holds it is sending.
 */
/**
 * Whether this browser could guard a payment at all, asked before a cash-out starts (adversary c30): with no Web
 * Locks, or storage that will not take the payment's record, Send would refuse at the end, after the sign-in and the
 * anchor's form. Returns why not, or null. The record is tried under its own key, so no real record is touched.
 */
export function cannotGuard(wallet: string, locks: Locks | undefined = browserLocks()): Held | null {
  if (!locks || typeof locks.request !== "function") return { held: true, until: null, reason: "unsupported" };
  const s = store();
  if (!s) return { held: true, until: null, reason: "unreadable" };
  const probe = `${KEY(wallet)}.check`;
  try {
    s.setItem(probe, "1");
    const kept = s.getItem(probe) === "1";
    s.removeItem(probe);
    return kept ? null : { held: true, until: null, reason: "unreadable" };
  } catch {
    return { held: true, until: null, reason: "unreadable" };
  }
}

export function acquireSend(wallet: string, anchorId: string, ledger: number, locks: Locks | undefined = browserLocks()): Promise<Begun> {
  if (!locks || typeof locks.request !== "function") return Promise.resolve({ ok: false, hold: { held: true, until: null, reason: "unsupported" } });
  // A payment of this tab that is done, or that the network has passed, holds the lock for nothing: let go first.
  return passLedger(wallet, ledger).then(() => lockAndBegin(wallet, anchorId, ledger, locks));
}

function lockAndBegin(wallet: string, anchorId: string, ledger: number, locks: Locks): Promise<Begun> {
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
      request = locks.request(LOCK(wallet), { ifAvailable: true }, async (lock) => {
        entered = true;
        if (!lock) {
          // Another tab holds the lock: it is sending, or still holds a payment the record no longer shows (adversary c33).
          const h = sendHold(wallet, ledger);
          return answer({ ok: false, hold: h.held ? h : { held: true, until: null, reason: "busy" } });
        }
        let begun: Begun;
        try {
          begun = beginSend(wallet, anchorId, ledger);
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

/** The latest ledger the RPC shows, within a limit; throws when it cannot be read. */
export async function readLedger(rpc: unknown): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      (rpc as { getLatestLedger(): Promise<{ sequence?: unknown }> }).getLatestLedger(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the Stellar network did not answer within ${LEDGER_READ_MS / 1000} seconds`)), LEDGER_READ_MS);
      }),
    ]);
    if (!isLedger(r?.sequence)) throw new Error("the Stellar network did not say which ledger it is at");
    return r.sequence;
  } finally {
    clearTimeout(timer);
  }
}

/** What the page says while a cash-out is held back. */
export function holdText(hold: Held, now: number = Date.now()): string {
  if (hold.reason === "unsupported") {
    return "This browser cannot keep two of its tabs from sending the same payment, so Caracal sends no USDC from it. Use an up-to-date browser.";
  }
  if (hold.reason === "busy") {
    return "Another tab of this browser is sending a USDC payment from this wallet, or is still waiting on one, so nothing was sent. Finish or close that tab, then press the button again.";
  }
  if (hold.reason === "unknown-expiry") {
    const ref = [hold.earlier.anchorId && `anchor transaction ${hold.earlier.anchorId}`, hold.earlier.hash && `Stellar payment ${hold.earlier.hash}`].filter(Boolean).join(", ");
    return `This browser holds a record of an earlier USDC payment to the anchor${ref ? ` (${ref})` : ""} that Caracal cannot read, or one from an older version of Caracal, so it cannot tell whether that payment may still go through or when it stops being able to. Check your wallet's USDC balance and history. If they show it went through, or you are sure it did not, press "I have checked my balance" to allow a new cash-out. A repeat of a payment that did go through would pay the anchor twice.`;
  }
  if (hold.reason !== "earlier-send") {
    return "Caracal cannot tell whether an earlier USDC payment from this browser is still on its way, because this browser would not let it check. No USDC can be sent from here until it can. Allow this site to store data, then reload.";
  }
  const ref = [hold.earlier.anchorId && `anchor transaction ${hold.earlier.anchorId}`, hold.earlier.hash && `Stellar payment ${hold.earlier.hash}`].filter(Boolean).join(", ");
  const head = `An earlier USDC payment to the anchor from this browser may still go through${ref ? ` (${ref})` : ""}. Check your wallet's USDC balance and history before you cash out again.`;
  if (hold.until === null) {
    return `${head} To keep you from paying twice, no new cash-out can start or send until Caracal reads on the Stellar network that it can no longer land; it checks every few seconds.`;
  }
  const mins = Math.max(1, Math.ceil((hold.until - now) / 60_000));
  return `${head} To keep you from paying twice, no new cash-out can start or send for about ${mins} ${mins === 1 ? "minute" : "minutes"}, until the network passes the last ledger it could land in.`;
}
