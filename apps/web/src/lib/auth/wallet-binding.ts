// A browser can be shared. The passkey wallet session the kit saves belongs to
// whoever created or connected it, so Caracal records which signed-in account
// that was and never restores the wallet for a different account. Signing out
// disconnects the wallet too.

export const WALLET_OWNER_KEY = "caracal.walletOwner";

/** The parts of window.localStorage used here, so tests can pass a fake. */
export type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/**
 * This browser's localStorage, read only when used. Reading window.localStorage
 * itself throws when the browser blocks site storage; passing it directly
 * would throw before sign-out could catch it and end the session.
 */
export const browserStore: KeyValue = {
  getItem: (k) => window.localStorage.getItem(k),
  setItem: (k, v) => window.localStorage.setItem(k, v),
  removeItem: (k) => window.localStorage.removeItem(k),
};

/** The part of the passkey kit used here. */
export type Disconnectable = { disconnect(): Promise<void> };

/** Record that the connected wallet belongs to this signed-in account. */
export function bindWallet(store: KeyValue, userId: string): void {
  store.setItem(WALLET_OWNER_KEY, userId);
}

/**
 * Before restoring a saved wallet session: true only if it was bound to this
 * same account. Otherwise the saved session is disconnected and forgotten.
 */
export async function mayRestoreWallet(store: KeyValue, kit: Disconnectable | Promise<Disconnectable>, userId: string): Promise<boolean> {
  let owner: string | null = null;
  try {
    owner = store.getItem(WALLET_OWNER_KEY);
  } catch (e) {
    // Unreadable counts as not bound: never restore what cannot be checked.
    console.error("could not read the wallet's owner:", errorText(e));
  }
  if (owner === userId) return true;
  try {
    store.removeItem(WALLET_OWNER_KEY);
  } catch (e) {
    // The saved session is still disconnected below, and it is not restored.
    console.error("could not forget the wallet's owner:", errorText(e));
  }
  await disconnectQuietly(kit);
  return false;
}

/** What ending a session reports. supabase-js resolves { error } instead of throwing. */
export type Ended = { error: unknown } | void;

/** The part of the Supabase auth client used to end a session. */
export type SessionAuth = {
  signOut(options?: { scope?: "global" | "local" | "others" }): Promise<{ error: unknown }>;
  getSession(): Promise<{ data: { session: unknown } }>;
};

/**
 * End the Supabase session in this browser. Tries to revoke it everywhere
 * first; if that fails (offline, server error), supabase-js keeps the session,
 * so this falls back to signing out this browser only, which removes the
 * session from storage before any network call. Reports an error only if the
 * session is still there afterwards.
 */
export async function endSupabaseSession(auth: SessionAuth): Promise<Ended> {
  // A revoke that never answers counts as failed, so the fallback still runs.
  const global = await settleWithin(auth.signOut(), SESSION_STEP_TIMEOUT_MS, "revoking the session");
  if (!global.error) return;
  console.error("could not revoke the session everywhere:", errorText(global.error));
  // Each step is bounded, so the caller always hears back instead of waiting forever.
  const local = await settleWithin(auth.signOut({ scope: "local" }), SESSION_STEP_TIMEOUT_MS, "signing out this browser");
  if (local.error) console.error("could not sign out this browser:", errorText(local.error));
  const stored = await settleWithin(
    auth.getSession().then(({ data }) => ({ error: data.session ? new Error("the session is still stored in this browser") : null })),
    SESSION_STEP_TIMEOUT_MS,
    "checking the session",
  );
  if (stored.error) return { error: stored.error };
}

/** Longest wait for each step of ending a session. */
export const SESSION_STEP_TIMEOUT_MS = 10_000;

/** Resolves with the step's { error }, or an error if it threw or did not settle in time. */
async function settleWithin(p: Promise<{ error: unknown }>, ms: number, what: string): Promise<{ error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ error: unknown }>((resolve) => {
    timer = setTimeout(() => resolve({ error: new Error(`${what} did not finish within ${ms} ms`) }), ms);
  });
  try {
    return await Promise.race([p.catch((e: unknown) => ({ error: e })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign out of the app: forget the wallet's owner, disconnect the wallet, and
 * end the session. The session is always ended, even if the wallet cannot be
 * disconnected (the kit failed to load, or its storage is blocked); the next
 * account still never gets this wallet, because the owner binding is gone.
 * Rejects if the session could not be ended, so the page never claims a
 * sign-out that did not happen.
 */
export async function signOutEverywhere(
  store: KeyValue,
  kit: Disconnectable | Promise<Disconnectable>,
  endSession: () => Promise<Ended>,
): Promise<void> {
  // If storage refuses, the binding stays; the next account still never
  // gets this wallet, because mayRestoreWallet compares it to their id.
  try {
    store.removeItem(WALLET_OWNER_KEY);
  } catch (e) {
    console.error("could not forget the wallet's owner:", errorText(e));
  }
  // The session ends at once, alongside the (time-bounded) wallet disconnect,
  // so a wallet kit that is slow or stuck never delays or blocks it.
  const [, session] = await Promise.allSettled([disconnectQuietly(kit), endSession()]);
  if (session.status === "rejected") throw session.reason;
  const ended = session.value;
  if (ended && ended.error) {
    throw new Error(`Sign-out did not finish: ${errorText(ended.error)}`);
  }
}

/** Shown when signing out failed and the person is still signed in. */
export const SIGN_OUT_FAILED = "Sign-out did not finish, so you are still signed in. Check your connection and try again.";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Longest wait for the wallet kit to load and disconnect before the session is ended anyway. */
export const DISCONNECT_TIMEOUT_MS = 5_000;

export async function disconnectQuietly(kit: Disconnectable | Promise<Disconnectable>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the wallet kit did not finish within ${DISCONNECT_TIMEOUT_MS} ms`)), DISCONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.resolve(kit).then((k) => k.disconnect()), stalled]);
  } catch (e) {
    console.error("could not disconnect the wallet:", errorText(e));
  } finally {
    clearTimeout(timer);
  }
}
