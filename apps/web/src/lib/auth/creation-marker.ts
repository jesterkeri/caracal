// Remembers, per account and across reloads, a wallet creation whose outcome
// is not known yet, so the wallet page does not offer a second one.

import type { KeyValue } from "./wallet-binding";

/**
 * Holds every account with an unconfirmed creation on this browser
 * (comma-separated ids; Supabase ids are UUIDs). An id is added just before a
 * creation is sent and removed once its outcome is known (created and
 * recorded, or nothing was sent). While it is set for the signed-in account,
 * the page offers only Connect, even after a reload.
 */
export const CREATION_UNCONFIRMED_KEY = "caracal.creationUnconfirmed";
/** The latest attempt's start (ms since epoch), for all accounts. */
export const CREATION_STARTED_AT_KEY = "caracal.creationStartedAt";
/**
 * How long a creation may still be finishing (the relay's own limits are
 * shorter). Before that, "start a new wallet anyway" waits: another tab, or
 * the network, may still complete the first one.
 */
export const CREATION_SETTLE_MS = 3 * 60_000;

export function creationMarker(store: KeyValue, now: () => number = () => Date.now()) {
  /** When this page last started a creation (kept in memory too, for browsers that block storage). */
  let startedHere = 0;

  function unconfirmedIds(): string[] {
    const v = store.getItem(CREATION_UNCONFIRMED_KEY);
    return v ? v.split(",").filter(Boolean) : [];
  }

  function creationUnconfirmedFor(id: string): boolean {
    try {
      return unconfirmedIds().includes(id);
    } catch {
      return false; // storage blocked: nothing could have been recorded either
    }
  }

  /**
   * Milliseconds since the latest unconfirmed creation on this browser started
   * (one start time for all accounts, so the wait is never shorter than any
   * attempt's). With no usable start time recorded (none, or one in the
   * future because the clock was set back), it is recorded now: an unknown age
   * waits the full time, then ends. With storage blocked, the start this page
   * itself recorded counts, or else the full wait.
   */
  function creationAge(): number {
    const t = now();
    try {
      const at = Number(store.getItem(CREATION_STARTED_AT_KEY));
      if (at > 0 && at <= t) return t - at;
      store.setItem(CREATION_STARTED_AT_KEY, String(t));
      return 0;
    } catch {
      if (startedHere > 0 && startedHere <= t) return t - startedHere;
      startedHere = t;
      return 0;
    }
  }

  /** Records (unconfirmed true) or clears this account's creation attempt; other accounts' are kept. */
  function markCreation(id: string, unconfirmed: boolean) {
    if (unconfirmed) startedHere = now();
    try {
      const others = unconfirmedIds().filter((x) => x !== id);
      const ids = unconfirmed ? [...others, id] : others;
      if (ids.length === 0) {
        store.removeItem(CREATION_UNCONFIRMED_KEY);
        store.removeItem(CREATION_STARTED_AT_KEY);
        return;
      }
      store.setItem(CREATION_UNCONFIRMED_KEY, ids.join(","));
      if (unconfirmed) store.setItem(CREATION_STARTED_AT_KEY, String(now()));
    } catch (e) {
      console.error("could not record the wallet creation attempt:", e instanceof Error ? e.message : String(e));
    }
  }

  return { creationUnconfirmedFor, creationAge, markCreation };
}
