// Finding the signed-in account's connected passkey wallet, the way the wallet
// page does (src/app/wallet/page.tsx), without creating or connecting one:
// a saved wallet session is restored only for the account that created or
// connected it (mayRestoreWallet), so a shared browser never opens one
// person's wallet for another.

import type { AccountAuth } from "../auth/account";
import { readSignInState } from "../auth/account";
import { mayRestoreWallet, type KeyValue } from "../auth/wallet-binding";

export type Account = { id: string; email: string | null };

export type Restored =
  | { kind: "signed-out" }
  | { kind: "unverified" }
  /** Signed in, but this browser holds no wallet session for this account: it is made or connected on the wallet page. */
  | { kind: "no-wallet"; account: Account }
  | { kind: "wallet"; account: Account; wallet: string }
  /** The sign-in was confirmed but the wallet could not be loaded (kit, storage or network). */
  | { kind: "failed"; account: Account; error: unknown };

/** The part of the passkey kit used to restore. */
export type RestoringKit = { disconnect(): Promise<void>; connectWallet(): Promise<{ contractId: string } | null> };

export async function restoreWallet(deps: {
  auth: AccountAuth;
  getKit: () => Promise<RestoringKit>;
  store: KeyValue;
  /** True once the page no longer wants the answer (unmounted, account changed). */
  stale: () => boolean;
  /** Called with the account as soon as it is confirmed. */
  onAccount?: (a: Account) => void;
}): Promise<Restored | null> {
  const now = await readSignInState(deps.auth);
  if (now.kind === "signed-out") return { kind: "signed-out" };
  if (now.kind === "unverified") return { kind: "unverified" };
  if (deps.stale()) return null;
  const account: Account = { id: now.id, email: now.email };
  deps.onAccount?.(account);
  try {
    const kit = await deps.getKit();
    if (deps.stale()) return null;
    if (!(await mayRestoreWallet(deps.store, kit, account.id))) return { kind: "no-wallet", account };
    if (deps.stale()) return null;
    const r = await kit.connectWallet();
    if (deps.stale()) return null;
    return r ? { kind: "wallet", account, wallet: r.contractId } : { kind: "no-wallet", account };
  } catch (error) {
    if (deps.stale()) return null;
    return { kind: "failed", account, error };
  }
}
