// One payment, or one cancellation, of an invoice at a time from this browser (Codex invoices R4).
//
// A payment or cancellation whose answer is lost may still land until its last ledger (payBy, cancelBy), so it is
// recorded in localStorage before the passkey is asked, and a reload or another tab holds back a second one until
// the invoice is read past it. Three rules keep that record honest:
//
// - It is begun under the invoice's Web Lock (atomic across the tabs of one site): only when no record is there,
//   and then read back, so two tabs cannot both see none and both send (R4 #3).
// - Storage that will not keep it, or a browser without Web Locks, sends nothing: a payment whose record is gone
//   after a reload could be repeated while it may still land (R4 #2).
// - Each attempt has its own id, and a record is removed only by the attempt whose outcome is certain, or by a
//   check that established that exact attempt can no longer land, under the same lock (R4 #1): an old check never
//   removes a newer attempt's record, even one with the same last ledger.
//
// The last ledger is kept where earlier versions kept it (a bare ledger for a payment, { ref: ledger } for a
// cancellation), and the id beside it, so a record an earlier version wrote is still read, as an attempt of its own.

import { browserLocks, type Locks } from "@/lib/auth/creation-lock";

export type Attempt = { id: string; by: number };

/** Where one invoice's record lives: its last ledger and its id, and the Web Lock that guards them. */
export type Slot = { lock: string; get(): { by: unknown; id: unknown }; set(a: Attempt): void; remove(): void };

const isLedger = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 0xffff_ffff;

const parseJson = (raw: string | null): unknown => {
  try {
    return JSON.parse(raw ?? "null") as unknown;
  } catch {
    return null;
  }
};

/** A payment of `ref` on `split`: localStorage caracal.payPending.<split>.<ref> (its payBy) and .id beside it. */
export function paySlot(split: string, ref: string): Slot {
  const key = `caracal.payPending.${split}.${ref}`;
  const idKey = `${key}.id`;
  return {
    lock: key,
    get: () => ({ by: parseJson(window.localStorage.getItem(key)), id: window.localStorage.getItem(idKey) }),
    set: (a) => {
      window.localStorage.setItem(idKey, a.id);
      window.localStorage.setItem(key, JSON.stringify(a.by));
    },
    remove: () => {
      window.localStorage.removeItem(key);
      window.localStorage.removeItem(idKey);
    },
  };
}

const CANCEL_KEY = "caracal.invoiceCancelPending";
const CANCEL_IDS = `${CANCEL_KEY}.ids`;

function readMap(key: string): Record<string, unknown> {
  const v = parseJson(window.localStorage.getItem(key));
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function writeEntry(key: string, ref: string, v: unknown) {
  const map = readMap(key);
  if (v === undefined) delete map[ref];
  else map[ref] = v;
  window.localStorage.setItem(key, JSON.stringify(map));
}

/**
 * A cancellation of `ref`: localStorage caracal.invoiceCancelPending ({ ref: cancelBy }) and .ids ({ ref: id }).
 * Every invoice shares those two entries, so one lock guards them all.
 */
export function cancelSlot(ref: string): Slot {
  return {
    lock: CANCEL_KEY,
    get: () => ({ by: readMap(CANCEL_KEY)[ref], id: readMap(CANCEL_IDS)[ref] }),
    set: (a) => {
      writeEntry(CANCEL_IDS, ref, a.id);
      writeEntry(CANCEL_KEY, ref, a.by);
    },
    remove: () => {
      writeEntry(CANCEL_KEY, ref, undefined);
      writeEntry(CANCEL_IDS, ref, undefined);
    },
  };
}

/** The attempt recorded in this slot, or null when none (or it cannot be read). Reads only: safe while rendering. */
export function attemptIn(slot: Slot): Attempt | null {
  try {
    const { by, id } = slot.get();
    if (!isLedger(by)) return null;
    // A record an earlier version wrote has no id: it is an attempt of its own, named by its ledger.
    return { id: typeof id === "string" && id.length > 0 && id.length <= 100 ? id : `legacy-${by}`, by };
  } catch {
    return null;
  }
}

export type Begun = { ok: true; attempt: Attempt } | { ok: false; held: Attempt } | { ok: false; refused: "unsupported" | "busy" | "storage" };

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Records a new attempt with last ledger `by`, under the slot's Web Lock, before anything is signed or sent:
 * refused when an attempt is already recorded (`held`), when another tab holds the lock ("busy"), when this
 * browser has no Web Locks ("unsupported"), or when storage does not keep the record ("storage").
 */
export async function beginAttempt(slot: Slot, by: number, locks: Locks | undefined = browserLocks()): Promise<Begun> {
  if (!locks || typeof locks.request !== "function") return { ok: false, refused: "unsupported" };
  if (!isLedger(by)) return { ok: false, refused: "storage" };
  let out: Begun = { ok: false, refused: "busy" };
  try {
    await locks.request(slot.lock, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const held = attemptIn(slot);
      if (held) {
        out = { ok: false, held };
        return;
      }
      const attempt = { id: newId(), by };
      try {
        slot.set(attempt);
      } catch {
        out = { ok: false, refused: "storage" };
        return;
      }
      const back = attemptIn(slot);
      out = back !== null && back.id === attempt.id && back.by === by ? { ok: true, attempt } : { ok: false, refused: "storage" };
    });
  } catch {
    return { ok: false, refused: "unsupported" };
  }
  return out;
}

/**
 * Removes the record of attempt `id`, and only that one, under the slot's Web Lock (tried for about a second if
 * another tab holds it for a moment). Resolves true once no record of that attempt is left.
 */
export async function endAttempt(slot: Slot, id: string, locks: Locks | undefined = browserLocks()): Promise<boolean> {
  if (!locks || typeof locks.request !== "function") return attemptIn(slot)?.id !== id;
  for (let i = 0; i < 40; i++) {
    let entered = false;
    let done = false;
    try {
      await locks.request(slot.lock, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        entered = true;
        try {
          if (attemptIn(slot)?.id === id) slot.remove();
        } catch {
          // storage refused: the record stays, and so does the hold
        }
        done = attemptIn(slot)?.id !== id;
      });
    } catch {
      return false;
    }
    if (entered) return done;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** What the page says when a new attempt is refused before anything is signed or sent. */
export function refusedText(why: "unsupported" | "busy" | "storage", what: "payment" | "cancellation"): string {
  const nothing = what === "payment" ? "nothing was sent" : "nothing was cancelled";
  if (why === "unsupported") return `This browser cannot keep two of its tabs from sending the same ${what}, so ${nothing}. Use an up-to-date browser.`;
  if (why === "busy") return `Another tab of this browser is starting a ${what} of this invoice, so ${nothing}. Wait a moment, then check again.`;
  return `This browser would not let Caracal keep a record of the ${what}, so ${nothing}: without it, a reload or another tab could send it again while it may still go through. Allow this site to store data, then try again.`;
}
