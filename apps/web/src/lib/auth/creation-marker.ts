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
/**
 * The wallet address each unconfirmed attempt would create ({ accountId:
 * address }, JSON), known once its passkey exists. Connecting that wallet is
 * what confirms the attempt; connecting another (an older wallet) is not.
 */
export const CREATION_PENDING_WALLET_KEY = "caracal.creationPendingWallet";
/** The latest attempt's start (ms since epoch), for all accounts. */
export const CREATION_STARTED_AT_KEY = "caracal.creationStartedAt";
/**
 * How long after its last sign of life a creation may still land. Before
 * that, "start a new wallet anyway" waits. The bound, from the relay
 * (apps/web/src/app/api/relay/route.ts): a request is sent upstream within
 * 60 s of arriving or never (SEND_DEADLINE_MS), and a wallet deployment is
 * forwarded with an authorisation that expires 12 ledgers (about 70 s) after
 * the ledger it was checked at (DEPLOY_AUTH_LEDGERS). The page renews the
 * start time every CREATION_HEARTBEAT_MS while an attempt runs, and again when
 * it ends, so 10 + 60 + about 70 s is under these 3 minutes. While a tab is
 * still running an attempt, it also holds the creation lock
 * (creation-lock.ts), so no other tab can start one.
 */
export const CREATION_SETTLE_MS = 3 * 60_000;
/** How often a running attempt renews its start time. */
export const CREATION_HEARTBEAT_MS = 10_000;

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

  function pendingWallets(): Record<string, string> {
    try {
      const v: unknown = JSON.parse(store.getItem(CREATION_PENDING_WALLET_KEY) ?? "{}");
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /** The wallet this account's unconfirmed attempt would create, if known. */
  function pendingWalletFor(id: string): string | null {
    try {
      const w = pendingWallets()[id];
      return typeof w === "string" ? w : null;
    } catch {
      return null;
    }
  }

  /**
   * Records (unconfirmed true) or clears this account's creation attempt;
   * other accounts' are kept. `wallet`: the address the attempt would create,
   * kept until the attempt is cleared.
   */
  function markCreation(id: string, unconfirmed: boolean, wallet?: string) {
    if (unconfirmed) startedHere = now();
    try {
      const pending = pendingWallets();
      if (unconfirmed && wallet) pending[id] = wallet;
      if (!unconfirmed) delete pending[id];
      if (Object.keys(pending).length === 0) store.removeItem(CREATION_PENDING_WALLET_KEY);
      else store.setItem(CREATION_PENDING_WALLET_KEY, JSON.stringify(pending));
    } catch (e) {
      console.error("could not record the attempt's wallet:", e instanceof Error ? e.message : String(e));
    }
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

  return { creationUnconfirmedFor, creationAge, markCreation, pendingWalletFor };
}
