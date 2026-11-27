// One wallet creation at a time in this browser, across all its tabs.
//
// Checking a localStorage note and then writing it is not atomic: two tabs can
// both see "no creation under way" and both start one. The browser's Web Locks
// API is atomic across tabs of one site, and a lock is let go when its tab
// closes or crashes, so a dead tab never blocks creation for good.

/** The part of the Web Locks API used here (navigator.locks). */
export type Locks = {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
};

export const CREATION_LOCK = "caracal.walletCreation";

export type Locked<T> = { ran: true; value: T } | { ran: false; why: "busy" | "unsupported" | "refused" };

/**
 * Runs `fn` while holding this browser's wallet-creation lock, and lets go
 * when it settles. Does not wait: if another tab holds the lock, `fn` does not
 * run ("busy"). Without Web Locks (no browser that supports passkeys lacks
 * them) nothing runs ("unsupported"): creation fails closed. If the browser
 * refuses the request itself (a SecurityError where site data is blocked, or
 * in a sandboxed frame), nothing runs either ("refused"). An error thrown by
 * `fn` once it has the lock is passed on as it is.
 */
export async function withCreationLock<T>(locks: Locks | undefined, fn: () => Promise<T>): Promise<Locked<T>> {
  if (!locks || typeof locks.request !== "function") return { ran: false, why: "unsupported" };
  let entered = false;
  try {
    return await locks.request(CREATION_LOCK, { ifAvailable: true }, async (lock): Promise<Locked<T>> => {
      entered = true;
      if (!lock) return { ran: false, why: "busy" };
      return { ran: true, value: await fn() };
    });
  } catch (e) {
    if (entered) throw e;
    return { ran: false, why: "refused" };
  }
}

/** This browser's Web Locks, or undefined where there are none (old browsers, server rendering). */
export function browserLocks(): Locks | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as { locks?: Locks }).locks;
}
