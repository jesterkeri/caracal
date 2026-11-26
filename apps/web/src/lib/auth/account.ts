// Which app account is signed in, as the pages show it and as wallet bindings
// rely on. Pure apart from the injected Supabase auth client, so it can be
// tested with a fake.

import { bindWallet, disconnectQuietly, type Disconnectable, type KeyValue } from "./wallet-binding";

type User = { id: string; email?: string | null };

/** The parts of the Supabase auth client used here. */
export type AccountAuth = {
  getUser(): Promise<{ data: { user: User | null }; error: unknown }>;
  getSession(): Promise<{ data: { session: unknown }; error?: unknown }>;
  onAuthStateChange(cb: (event: string, session: { user: User } | null) => void): { data: { subscription: { unsubscribe(): void } } };
};

/**
 * verified: Supabase confirmed this account just now.
 * unverified: a session is stored in this browser, but Supabase could not
 *   confirm it (unreachable, or it refused the session). It is not shown as
 *   signed in; it can only be signed out.
 * signed-out: no session in this browser.
 */
export type SignInState = { kind: "verified"; id: string; email: string | null } | { kind: "unverified" } | { kind: "signed-out" };

export async function readSignInState(auth: AccountAuth): Promise<SignInState> {
  try {
    const { data, error } = await auth.getUser();
    if (data.user) return { kind: "verified", id: data.user.id, email: data.user.email ?? null };
    if (!error) return { kind: "signed-out" };
    console.error("could not verify the session:", errorText(error));
  } catch (e) {
    console.error("could not verify the session:", errorText(e));
  }
  // Not verified. A session still stored here keeps its sign-out control.
  try {
    // With an expired access token and Supabase unreachable, supabase-js
    // returns { session: null, error } while the session and its refresh token
    // stay stored. That is not "signed out": it cannot be told apart from a
    // live session, so it keeps its Sign out control.
    const { data, error } = await auth.getSession();
    if (error) console.error("could not read the stored session:", errorText(error));
    return data.session || error ? { kind: "unverified" } : { kind: "signed-out" };
  } catch (e) {
    console.error("could not read the stored session:", errorText(e));
    return { kind: "unverified" };
  }
}

/**
 * Calls `onChange` once the account signed in to this browser is no longer
 * `expectedId` (null: no account): a sign-out, or another account signing in,
 * here or in another tab (supabase-js relays auth events between tabs).
 * Events that arrive while `ownChange()` is true (this tab is signing out
 * itself) are not reported. Returns the unsubscribe function.
 */
export function followAccount(auth: AccountAuth, expectedId: string | null, onChange: () => void, ownChange: () => boolean = () => false): () => void {
  let fired = false;
  const { data } = auth.onAuthStateChange((_event, session) => {
    if (fired || ownChange() || (session?.user?.id ?? null) === expectedId) return;
    fired = true;
    onChange();
  });
  return () => data.subscription.unsubscribe();
}

/**
 * bound: the wallet is recorded as this account's.
 * not-saved: the account could not be confirmed, or storage refused; the
 *   wallet stays connected for this visit and is not restored on a later one.
 * account-changed: another account (or none) is now signed in; nothing was
 *   recorded and the wallet was disconnected.
 */
export type BindOutcome = "bound" | "not-saved" | "account-changed";

/** Records the wallet's owner only after confirming `expectedId` is still the signed-in account. */
export async function bindIfStillSignedIn(store: KeyValue, auth: AccountAuth, kit: Disconnectable | Promise<Disconnectable>, expectedId: string): Promise<BindOutcome> {
  const now = await readSignInState(auth);
  if (now.kind === "unverified") return "not-saved";
  if (now.kind === "signed-out" || now.id !== expectedId) {
    await disconnectQuietly(kit);
    return "account-changed";
  }
  try {
    bindWallet(store, expectedId);
    return "bound";
  } catch (e) {
    console.error("could not record the wallet's owner:", errorText(e));
    return "not-saved";
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
