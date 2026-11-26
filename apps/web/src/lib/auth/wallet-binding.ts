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
export async function mayRestoreWallet(store: KeyValue, kit: Disconnectable, userId: string): Promise<boolean> {
  if (store.getItem(WALLET_OWNER_KEY) === userId) return true;
  await kit.disconnect();
  store.removeItem(WALLET_OWNER_KEY);
  return false;
}

/** Sign out of the app: disconnect the wallet and forget its owner, then end the session. */
export async function signOutEverywhere(store: KeyValue, kit: Disconnectable, endSession: () => Promise<unknown>): Promise<void> {
  await kit.disconnect();
  store.removeItem(WALLET_OWNER_KEY);
  await endSession();
}
