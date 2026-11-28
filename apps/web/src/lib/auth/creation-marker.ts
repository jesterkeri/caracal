// Remembers, per account and across reloads, a wallet creation whose outcome
// is not known yet, so the wallet page does not offer a second one.

import { DEPLOY_AUTH_LEDGERS } from "../relay/deploy-auth";
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
 * The first of two waits before "start a new wallet anyway": time after the
 * attempt's last sign of life, so a person is not offered a second wallet while
 * the first may still be on its way (the page renews the start time every
 * CREATION_HEARTBEAT_MS while an attempt runs and again when it ends). While a
 * tab is still running an attempt, it also holds the creation lock
 * (creation-lock.ts), so no other tab can start one.
 *
 * Time does not bound when a sent attempt can LAND, and a browser clock can
 * jump: the bound that does is the close ledger (CREATION_CLOSE_LEDGER_KEY).
 */
export const CREATION_SETTLE_MS = 3 * 60_000;
/**
 * The last ledger in which each account's unconfirmed attempt can land
 * ({ accountId: ledger }, JSON). Before sending, the page reads the network's
 * latest ledger, adds CREATION_CLOSE_LEDGERS, records the result here for its
 * account and sends it to the relay as `closeBy`. The relay re-signs the deployment's authorisation to expire no
 * later than that ledger, and refuses to send once the network has reached it
 * (deploy-auth.ts), so an attempt cannot land after it, whatever any RPC's lag
 * or any clock. The page's own RPC reporting a later ledger proves the network
 * passed it. Each account's bound is its own: an attempt with no bound recorded
 * stays unknown, and another account's later attempt never bounds it (Codex
 * Day 1 R8 #1). An account's entry goes when its attempt is cleared. A value
 * in the older single-number form names no account, so it bounds none.
 */
export const CREATION_CLOSE_LEDGER_KEY = "caracal.creationCloseLedger";
/**
 * Ledgers from the page's read to its `closeBy`: about 3 minutes at testnet's
 * 5 to 6 s per ledger (the same as CREATION_SETTLE_MS), room for the passkey
 * prompt and the relay; a shorter bound means a shorter wait before the escape. A creation
 * that reaches the relay later is refused before sending ("Nothing was sent").
 * At least DEPLOY_AUTH_LEDGERS, so the relay's own short expiry still applies.
 */
export const CREATION_CLOSE_LEDGERS = Math.max(36, DEPLOY_AUTH_LEDGERS);
/**
 * Wallets an earlier attempt may have made although the network did not show
 * them when a new wallet was started anyway ({ accountId: [address] }, JSON):
 * an RPC may leave out a wallet whose data was archived, so "not found" never
 * drops the address. The wallet page keeps naming them.
 */
export const POSSIBLE_WALLETS_KEY = "caracal.possibleWallets";
/** How often a running attempt renews its start time. */
export const CREATION_HEARTBEAT_MS = 10_000;

export function creationMarker(store: KeyValue, now: () => number = () => Date.now()) {
  /** When this page last started a creation (kept in memory too, for browsers that block storage). */
  let startedHere = 0;
  /** The close ledgers this page recorded, per account (kept in memory too, for browsers that block storage). */
  const closeHere = new Map<string, number>();

  /** Every account's recorded close ledger. Anything unreadable, or in the older single-number form, names none. */
  function closeLedgers(): Record<string, number> {
    try {
      const v: unknown = JSON.parse(store.getItem(CREATION_CLOSE_LEDGER_KEY) ?? "{}");
      if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => Number.isSafeInteger(e[1]) && (e[1] as number) > 0));
    } catch {
      return {};
    }
  }

  /** The ledger after which this account's attempt can no longer land; null when none was recorded for it. */
  function closeLedger(id: string): number | null {
    const stored = closeLedgers()[id];
    const here = closeHere.get(id);
    if (stored === undefined) return here ?? null;
    return here !== undefined && here > stored ? here : stored;
  }

  /**
   * Records this account's attempt's close ledger before it is sent (see
   * CREATION_CLOSE_LEDGER_KEY). Never lowers the one already recorded for it.
   * With storage blocked it is kept in memory, all this page could read back anyway.
   */
  function recordCloseLedger(id: string, ledger: number) {
    const before = closeLedger(id);
    const next = before !== null && before > ledger ? before : ledger;
    closeHere.set(id, next);
    try {
      store.setItem(CREATION_CLOSE_LEDGER_KEY, JSON.stringify({ ...closeLedgers(), [id]: next }));
    } catch (e) {
      console.error("could not record the close ledger:", e instanceof Error ? e.message : String(e));
    }
  }

  /** Drops this account's close ledger (its attempt was cleared); the key goes once none is left. */
  function forgetCloseLedger(id: string) {
    closeHere.delete(id);
    const rest = closeLedgers();
    delete rest[id];
    if (Object.keys(rest).length === 0) store.removeItem(CREATION_CLOSE_LEDGER_KEY);
    else store.setItem(CREATION_CLOSE_LEDGER_KEY, JSON.stringify(rest));
  }

  function possibleWallets(): Record<string, string[]> {
    try {
      const v: unknown = JSON.parse(store.getItem(POSSIBLE_WALLETS_KEY) ?? "{}");
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, string[]>) : {};
    } catch {
      return {};
    }
  }

  /** Wallets an earlier attempt of this account may have made (see POSSIBLE_WALLETS_KEY). */
  function possibleWalletsFor(id: string): string[] {
    const list = possibleWallets()[id];
    return Array.isArray(list) ? list.filter((w): w is string => typeof w === "string") : [];
  }

  /**
   * Keeps an address an earlier attempt may have made, before a new wallet is started anyway. True only when
   * the address reads back from storage: otherwise the caller must not drop the attempt's record, which is
   * then the only place the address is kept (Codex Day 1 R8 #2).
   */
  function rememberPossibleWallet(id: string, wallet: string): boolean {
    try {
      const all = possibleWallets();
      const list = possibleWalletsFor(id);
      if (!list.includes(wallet)) all[id] = [...list, wallet];
      store.setItem(POSSIBLE_WALLETS_KEY, JSON.stringify(all));
      return possibleWalletsFor(id).includes(wallet);
    } catch (e) {
      console.error("could not record the earlier attempt's wallet:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }

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
      if (!unconfirmed) forgetCloseLedger(id);
      if (ids.length === 0) {
        // No attempt is unconfirmed: no close ledger bounds anything any more.
        closeHere.clear();
        store.removeItem(CREATION_UNCONFIRMED_KEY);
        store.removeItem(CREATION_STARTED_AT_KEY);
        store.removeItem(CREATION_CLOSE_LEDGER_KEY);
        return;
      }
      store.setItem(CREATION_UNCONFIRMED_KEY, ids.join(","));
      if (unconfirmed) store.setItem(CREATION_STARTED_AT_KEY, String(now()));
    } catch (e) {
      console.error("could not record the wallet creation attempt:", e instanceof Error ? e.message : String(e));
    }
  }

  return { creationUnconfirmedFor, creationAge, markCreation, pendingWalletFor, closeLedger, recordCloseLedger, possibleWalletsFor, rememberPossibleWallet };
}
