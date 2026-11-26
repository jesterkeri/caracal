// A browser can be shared. The passkey wallet session the kit saves belongs to
// whoever created or connected it, so Caracal records which signed-in account
// that was and never restores the wallet for a different account. Signing out
// disconnects the wallet too.

export const WALLET_OWNER_KEY = "caracal.walletOwner";

/** The parts of window.localStorage used here, so tests can pass a fake. */
export type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;
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
  if (store.getItem(WALLET_OWNER_KEY) === userId) return true;
  store.removeItem(WALLET_OWNER_KEY);
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
  const global = await auth.signOut();
  if (!global.error) return;
  console.error("could not revoke the session everywhere:", errorText(global.error));
  await auth.signOut({ scope: "local" });
  const { data } = await auth.getSession();
  if (data.session) return { error: new Error("the session is still stored in this browser") };
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
  let ended: Ended;
  try {
    // If storage refuses, the binding stays; the next account still never
    // gets this wallet, because mayRestoreWallet compares it to their id.
    try {
      store.removeItem(WALLET_OWNER_KEY);
    } catch (e) {
      console.error("could not forget the wallet's owner:", errorText(e));
    }
    await disconnectQuietly(kit);
  } finally {
    ended = await endSession();
  }
  if (ended && ended.error) {
    throw new Error(`Sign-out did not finish: ${errorText(ended.error)}`);
  }
}

/** Shown when signing out failed and the person is still signed in. */
export const SIGN_OUT_FAILED = "Sign-out did not finish, so you are still signed in. Check your connection and try again.";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function disconnectQuietly(kit: Disconnectable | Promise<Disconnectable>): Promise<void> {
  try {
    await (await kit).disconnect();
  } catch (e) {
    console.error("could not disconnect the wallet:", errorText(e));
  }
}
