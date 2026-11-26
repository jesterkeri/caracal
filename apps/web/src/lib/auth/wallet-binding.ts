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

/**
 * Sign out of the app: forget the wallet's owner, disconnect the wallet, and
 * end the session. The session always ends, even if the wallet cannot be
 * disconnected (the kit failed to load, or its storage is blocked); the next
 * account still never gets this wallet, because the owner binding is gone.
 */
export async function signOutEverywhere(
  store: KeyValue,
  kit: Disconnectable | Promise<Disconnectable>,
  endSession: () => Promise<unknown>,
): Promise<void> {
  store.removeItem(WALLET_OWNER_KEY);
  try {
    await disconnectQuietly(kit);
  } finally {
    await endSession();
  }
}

async function disconnectQuietly(kit: Disconnectable | Promise<Disconnectable>): Promise<void> {
  try {
    await (await kit).disconnect();
  } catch (e) {
    console.error("could not disconnect the wallet:", e instanceof Error ? e.message : String(e));
  }
}
