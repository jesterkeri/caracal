// Holding back a new cash-out while an earlier USDC payment from this browser may still land.
//
// The page's own locks (sendingFor, unknownSend, the landing window) live in its memory, so a reload, a
// crash, leaving the page, or the reload another tab's account change causes, used to reset it to a fresh
// cash-out while the first payment could still land: the person could then pay a second time (Codex
// cash-out R1 #1). So every payment leaves a record in localStorage BEFORE the passkey is asked, renewed
// every 10 s and on pagehide while this tab's send is in hand, and no cash-out of this wallet starts or
// sends while a record is fresh. The record is removed only when the outcome is certain (confirmed sent,
// or proven not sent).
//
// When can an uncertain payment no longer land? While this tab's signAndSubmit is still pending it can, so
// the record keeps being renewed. Once that has settled, or the tab was closed or reloaded (a dead tab posts
// nothing new), only a request already at the relay is left: it sends within SEND_DEADLINE_MS (60 s) and
// the transaction it builds is valid TX_TIMEOUT_S (25 s). SETTLE_MS is 3 minutes after the last renewal,
// more than twice that.
//
// Checking the record and writing it are two steps, so acquireSend takes this wallet's Web Lock first
// (atomic across the tabs of one site) and holds it while the payment may still be sent from this tab; the
// browser lets it go if the tab dies. Storage that cannot be read holds back; storage that cannot be written,
// or a browser without Web Locks, refuses to send, because nothing would stop a repeat.

import { browserLocks, type Locks } from "@/lib/auth/creation-lock";

export const SETTLE_MS = 3 * 60_000;
export const HEARTBEAT_MS = 10_000;
const KEY = (wallet: string) => `caracal.cashout.send.${wallet}`;
const LOCK = (wallet: string) => `caracal.cashout.send.${wallet}`;

/** The anchor's transaction id and the payment's hash, when known: shown so the person can follow it up. */
export type Earlier = { anchorId: string | null; hash: string | null };
export type Hold =
  | { held: false }
  | { held: true; until: number | null; reason: "earlier-send"; earlier: Earlier }
  | { held: true; until: null; reason: "unreadable" | "unsupported" };
type Held = Extract<Hold, { held: true }>;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Rec = { id: string; beat: number; anchorId: string | null; hash: string | null; ahead: boolean };

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

/** The record for this wallet: undefined when none, null when it is there but cannot be read. */
function read(s: Store, wallet: string, now: number): Rec | null | undefined {
  try {
    const raw = s.getItem(KEY(wallet));
    if (raw === null || raw === undefined) return undefined;
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof v?.id !== "string" || typeof v.beat !== "number" || !Number.isFinite(v.beat)) throw new Error("bad record");
    // A renewal time in the future (a changed clock) counts as now, and is written back as now below.
    return { id: v.id, beat: Math.min(v.beat, now), anchorId: text(v.anchorId), hash: text(v.hash), ahead: v.beat > now };
  } catch {
    return null;
  }
}

const write = (s: Store, wallet: string, r: Omit<Rec, "ahead">) => s.setItem(KEY(wallet), JSON.stringify(r));

/** Whether a cash-out of this wallet must wait. Storage that cannot be read holds back. */
export function sendHold(wallet: string, now: number = Date.now()): Hold {
  const s = store();
  if (!s) return { held: true, until: null, reason: "unreadable" };
  const rec = read(s, wallet, now);
  if (rec === undefined) return { held: false };
  if (rec === null) {
    // A record that cannot be read is treated as written just now, so it expires and is not a trap.
    try {
      write(s, wallet, { id: "unreadable", beat: now, anchorId: null, hash: null });
    } catch {
      return { held: true, until: null, reason: "unreadable" };
    }
    return { held: true, until: now + SETTLE_MS, reason: "earlier-send", earlier: { anchorId: null, hash: null } };
  }
  if (rec.ahead) {
    // Renewed "in the future" (the clock was ahead, then set back): recorded again as renewed now, so it holds
    // for SETTLE_MS from here, not for as long as the clock was off. Same id, so a tab still sending renews it.
    try {
      write(s, wallet, { id: rec.id, beat: now, anchorId: rec.anchorId, hash: rec.hash });
    } catch {
      return { held: true, until: null, reason: "unreadable" };
    }
  }
  return now - rec.beat < SETTLE_MS ? { held: true, until: rec.beat + SETTLE_MS, reason: "earlier-send", earlier: { anchorId: rec.anchorId, hash: rec.hash } } : { held: false };
}

export type SendGuard = {
  /** The kit's signAndSubmit promise, watched so the record lasts while it is pending. */
  watch<T>(p: Promise<T>): Promise<T>;
  /** The payment's hash once known, kept in the record so a reloaded page can show it. */
  noteHash(hash: string): void;
  /** The outcome: a certain one removes the record; an unknown one keeps it until the payment can no longer land. */
  finish(kind: "sent" | "not-sent" | "unknown"): void;
  /** Settles once nothing more can be sent from this tab. */
  released: Promise<void>;
};

type Begun = { ok: true; guard: SendGuard } | { ok: false; hold: Held };

/** Takes the hold for this wallet before the passkey is asked: refused when an earlier payment holds it. */
export function beginSend(wallet: string, anchorId: string, now: () => number = Date.now): Begun {
  const hold = sendHold(wallet, now());
  if (hold.held) return { ok: false, hold };
  const s = store();
  if (!s) return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  const id = `${now()}-${Math.random().toString(36).slice(2)}`;
  let hash: string | null = null;
  try {
    write(s, wallet, { id, beat: now(), anchorId, hash });
    if (read(s, wallet, now())?.id !== id) return { ok: false, hold: { held: true, until: now() + SETTLE_MS, reason: "earlier-send", earlier: { anchorId: null, hash: null } } };
  } catch {
    return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  }
  const mine = () => {
    try {
      return read(s, wallet, now())?.id === id;
    } catch {
      return false;
    }
  };
  const renew = () => {
    try {
      if (mine()) write(s, wallet, { id, beat: now(), anchorId, hash });
    } catch {
      /* the next renewal tries again; the record only ages */
    }
  };
  const beat = setInterval(renew, HEARTBEAT_MS);
  window.addEventListener?.("pagehide", renew);
  let pending = 0;
  let unknown = false;
  let release = () => {};
  const released = new Promise<void>((r) => (release = r));
  const stop = () => {
    clearInterval(beat);
    window.removeEventListener?.("pagehide", renew);
    release();
  };
  const settled = () => {
    pending--;
    if (unknown && pending === 0) {
      renew();
      stop();
    }
  };
  return {
    ok: true,
    guard: {
      released,
      watch(p) {
        pending++;
        p.then(settled, settled);
        return p;
      },
      noteHash(h) {
        hash = text(h);
        renew();
      },
      finish(kind) {
        if (kind === "unknown") {
          unknown = true;
          renew();
          if (pending === 0) stop();
          return;
        }
        stop();
        try {
          if (mine()) s.removeItem(KEY(wallet));
        } catch {
          /* the record ages out */
        }
      },
    },
  };
}

/**
 * beginSend under this wallet's Web Lock, held until the guard is released, so no other tab of this browser
 * can check and write the record at the same time. Does not wait for the lock: a tab that holds it is sending.
 */
export function acquireSend(wallet: string, anchorId: string, locks: Locks | undefined = browserLocks(), now: () => number = Date.now): Promise<Begun> {
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
      request = locks.request(LOCK(wallet), { ifAvailable: true }, async (lock) => {
        entered = true;
        if (!lock) {
          const h = sendHold(wallet, now());
          return answer({ ok: false, hold: h.held ? h : { held: true, until: null, reason: "earlier-send", earlier: { anchorId: null, hash: null } } });
        }
        let begun: Begun;
        try {
          begun = beginSend(wallet, anchorId, now);
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

/** What the page says while a cash-out is held back. */
export function holdText(hold: Held, now: number = Date.now()): string {
  if (hold.reason === "unsupported") {
    return "This browser cannot keep two of its tabs from sending the same payment, so Caracal sends no USDC from it. Use an up-to-date browser.";
  }
  if (hold.reason !== "earlier-send") {
    return "Caracal cannot tell whether an earlier USDC payment from this browser is still on its way, because this browser would not let it check. No USDC can be sent from here until it can. Allow this site to store data, then reload.";
  }
  const mins = hold.until === null ? 3 : Math.max(1, Math.ceil((hold.until - now) / 60_000));
  const ref = [hold.earlier.anchorId && `anchor transaction ${hold.earlier.anchorId}`, hold.earlier.hash && `Stellar payment ${hold.earlier.hash}`].filter(Boolean).join(", ");
  return `An earlier USDC payment to the anchor from this browser may still go through${ref ? ` (${ref})` : ""}. Check your wallet's USDC balance and history before you cash out again. To keep you from paying twice, no new cash-out can start or send for about ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
}
