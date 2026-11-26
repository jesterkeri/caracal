"use client";

import type { SmartAccountKit } from "smart-account-kit";
import { NETWORK, SMART_ACCOUNT } from "./config";

let kitPromise: Promise<SmartAccountKit> | null = null;

export const HTTPS_RPC_REQUIRED =
  "The wallet needs an https Stellar RPC. Set NEXT_PUBLIC_STELLAR_RPC_URL to an https address, or leave it unset for the testnet default.";

/** One passkey smart-account kit per browser tab, created on first use. */
export function getKit(): Promise<SmartAccountKit> {
  if (!kitPromise) {
    // smart-account-kit 0.10.0 refuses an http RPC and offers no way to allow
    // one, so say which setting is wrong instead of passing on its error.
    if (!NETWORK.rpcUrl.startsWith("https://")) {
      return Promise.reject(new Error(HTTPS_RPC_REQUIRED));
    }
    kitPromise = import("smart-account-kit").then(
      ({ SmartAccountKit, IndexedDBStorage }) =>
        new SmartAccountKit({
          rpcUrl: NETWORK.rpcUrl,
          networkPassphrase: NETWORK.passphrase,
          accountWasmHash: SMART_ACCOUNT.accountWasmHash,
          webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
          relayerUrl: `${window.location.origin}/api/relay`,
          storage: new IndexedDBStorage(),
          rpName: "Caracal",
        }),
    );
    // A failed load (say, a network blip fetching the chunk) is not kept, so
    // the next call tries again instead of failing until the page reloads.
    kitPromise.catch(() => {
      kitPromise = null;
    });
  }
  return kitPromise;
}
