"use client";

import type { SmartAccountKit } from "smart-account-kit";
import { NETWORK, SMART_ACCOUNT } from "./config";

let kitPromise: Promise<SmartAccountKit> | null = null;
let unsavedKitPromise: Promise<SmartAccountKit> | null = null;

export const HTTPS_RPC_REQUIRED =
  "The wallet needs an https Stellar RPC. Set NEXT_PUBLIC_STELLAR_RPC_URL to an https address, or leave it unset for the testnet default.";

/** An https URL, the scheme in any case (as URL parsing and the kit accept it). */
function isHttps(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * One passkey smart-account kit per browser tab, created on first use.
 *
 * `saveSession: false` gives a separate kit that keeps its session in memory
 * only. The kit saves a session for every wallet it connects, and the saved
 * one is the signed-in person's wallet that the wallet, split and invoices
 * pages restore; a payer connecting on a pay link must never replace it.
 */
export function getKit(options: { saveSession?: boolean } = {}): Promise<SmartAccountKit> {
  const save = options.saveSession !== false;
  if (save ? !kitPromise : !unsavedKitPromise) {
    // smart-account-kit 0.10.0 refuses an http RPC and offers no way to allow
    // one, so say which setting is wrong instead of passing on its error.
    if (!isHttps(NETWORK.rpcUrl)) {
      return Promise.reject(new Error(HTTPS_RPC_REQUIRED));
    }
    const made = import("smart-account-kit").then(
      (kit) =>
        new kit.SmartAccountKit({
          rpcUrl: NETWORK.rpcUrl,
          networkPassphrase: NETWORK.passphrase,
          accountWasmHash: SMART_ACCOUNT.accountWasmHash,
          webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
          relayerUrl: `${window.location.origin}/api/relay`,
          storage: save ? new kit.IndexedDBStorage() : new kit.MemoryStorage(),
          rpName: "Caracal",
        }),
    );
    // A failed load (say, a network blip fetching the chunk) is not kept, so
    // the next call tries again instead of failing until the page reloads.
    made.catch(() => {
      if (save) kitPromise = null;
      else unsavedKitPromise = null;
    });
    if (save) kitPromise = made;
    else unsavedKitPromise = made;
  }
  return (save ? kitPromise : unsavedKitPromise)!;
}
