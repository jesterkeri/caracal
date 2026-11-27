// Holding back a second write while an earlier one may still land.
//
// sendSplitCall stops waiting after SEND_TIMEOUT_MS, but that does not cancel
// the kit's signAndSubmit: the first write can still be posted to the relay and
// confirmed. A person who signed the same withdrawal again could then have both
// land. So every write leaves a record in localStorage BEFORE anything is sent,
// renewed every 10 s and on pagehide while this tab has the write in hand, and
// no write of any kind on this split starts while a record is fresh. The record
// is removed only when the outcome is certain (done, refused, stopped).
//
// When can an uncertain write no longer land? While this tab's signAndSubmit is
// still pending it can, so the record keeps being renewed. Once that has
// settled, or the tab was closed or reloaded (a dead tab posts nothing new), the
// only thing left is a request already at the relay: it sends within
// SEND_DEADLINE_MS (60 s) and the transaction it builds is valid TX_TIMEOUT_S
// (25 s). SETTLE_MS is 3 minutes after the last renewal, more than twice that.
//
// Storage that cannot be read holds back; storage that cannot be written
// refuses to start a write, because nothing would stop a repeat.

import type { SendOutcome, WriteKit } from "./send";

export const SETTLE_MS = 3 * 60_000;
export const HEARTBEAT_MS = 10_000;
const KEY = (split: string) => `caracal.split.write.${split}`;

export type Hold = { held: false } | { held: true; until: number | null; reason: "earlier-write" | "unreadable" };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Record_ = { id: string; beat: number; ahead?: boolean };

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/** The record for this split: undefined when none, null when it is there but cannot be read. */
function read(s: Store, split: string, now: number): Record_ | null | undefined {
  try {
    const raw = s.getItem(KEY(split));
    if (raw === null || raw === undefined) return undefined;
    const v = JSON.parse(raw) as Partial<Record_>;
    if (typeof v?.id !== "string" || typeof v.beat !== "number" || !Number.isFinite(v.beat)) throw new Error("bad record");
    // A renewal time in the future (a changed clock) counts as now; holdOn records it again as now, so it
    // ages from the first time it is seen and cannot hold for longer than SETTLE_MS from there.
    return { id: v.id, beat: Math.min(v.beat, now), ahead: v.beat > now };
  } catch {
    return null;
  }
}

/** Whether a write on this split must wait. Storage that cannot be read holds back. */
export function holdOn(split: string, now: number = Date.now()): Hold {
  const s = store();
  if (!s) return { held: true, until: null, reason: "unreadable" };
  let rec: Record_ | null | undefined;
  try {
    rec = read(s, split, now);
  } catch {
    return { held: true, until: null, reason: "unreadable" };
  }
  if (rec === undefined) return { held: false };
  if (rec === null) {
    // A record that cannot be read is treated as written just now, so it expires and is not a trap.
    try {
      s.setItem(KEY(split), JSON.stringify({ id: "unreadable", beat: now }));
    } catch {
      return { held: true, until: null, reason: "unreadable" };
    }
    return { held: true, until: now + SETTLE_MS, reason: "earlier-write" };
  }
  if (rec.ahead) {
    // Renewed "in the future" (the clock was ahead, then set back): recorded again as renewed now, so it
    // ages from here and holds for SETTLE_MS, not for as long as the clock was off (adversary s8). Same id,
    // so a tab still holding this write keeps renewing it.
    try {
      s.setItem(KEY(split), JSON.stringify({ id: rec.id, beat: now }));
    } catch {
      return { held: true, until: null, reason: "unreadable" };
    }
  }
  return now - rec.beat < SETTLE_MS ? { held: true, until: rec.beat + SETTLE_MS, reason: "earlier-write" } : { held: false };
}

export type WriteGuard = {
  /** The kit, with its signAndSubmit watched so the record lasts while it is pending. */
  kit(k: WriteKit): WriteKit;
  /** The outcome: certain ones remove the record; an unknown one keeps it until it can no longer land. */
  finish(outcome: SendOutcome): void;
};

/** Takes the hold on this split before anything is sent: refused when another write holds it. */
export function beginWrite(split: string, now: () => number = Date.now): { ok: true; guard: WriteGuard } | { ok: false; hold: Extract<Hold, { held: true }> } {
  const hold = holdOn(split, now());
  if (hold.held) return { ok: false, hold };
  const s = store();
  if (!s) return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  const id = `${now()}-${Math.random().toString(36).slice(2)}`;
  try {
    s.setItem(KEY(split), JSON.stringify({ id, beat: now() }));
    // Another tab may have written between the check and this write: only the last writer proceeds.
    if (read(s, split, now())?.id !== id) return { ok: false, hold: { held: true, until: now() + SETTLE_MS, reason: "earlier-write" } };
  } catch {
    return { ok: false, hold: { held: true, until: null, reason: "unreadable" } };
  }
  const mine = () => {
    try {
      return read(s, split, now())?.id === id;
    } catch {
      return false;
    }
  };
  const renew = () => {
    try {
      if (mine()) s.setItem(KEY(split), JSON.stringify({ id, beat: now() }));
    } catch {
      /* the next renewal tries again; the record only ages */
    }
  };
  const beat = setInterval(renew, HEARTBEAT_MS);
  window.addEventListener?.("pagehide", renew);
  let pending = 0;
  let unknown = false;
  let restore = () => {};
  const stop = () => {
    clearInterval(beat);
    window.removeEventListener?.("pagehide", renew);
  };
  const settled = () => {
    pending--;
    if (unknown && pending === 0) {
      renew();
      stop();
    }
  };
  const guard: WriteGuard = {
    kit(k) {
      // The same kit object goes on (one write runs at a time), with its signAndSubmit watched until finish().
      const original = k.signAndSubmit;
      if (typeof original !== "function") return k;
      k.signAndSubmit = (tx) => {
        pending++;
        const p = original.call(k, tx);
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
        renew();
        if (pending === 0) stop();
        return;
      }
      stop();
      try {
        if (mine()) s.removeItem(KEY(split));
      } catch {
        /* the record ages out */
      }
    },
  };
  return { ok: true, guard };
}

/** What the page says while a write is held back. */
export function holdText(hold: Extract<Hold, { held: true }>, now: number = Date.now()): string {
  if (hold.reason === "unreadable") {
    return "Caracal cannot tell whether an earlier withdrawal or move is still on its way, because this browser would not let it check. Nothing can be sent from here until it can. Refresh the pots, and allow this site to store data.";
  }
  const mins = hold.until === null ? 3 : Math.max(1, Math.ceil((hold.until - now) / 60_000));
  return `An earlier withdrawal, move or change may still go through. Check the pots above before you repeat it. To keep you from sending it twice, nothing new can be sent for about ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
}
