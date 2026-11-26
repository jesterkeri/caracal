"use client";

import type { SmartAccountKit } from "smart-account-kit";
import { NETWORK, SMART_ACCOUNT } from "./config";

let kitPromise: Promise<SmartAccountKit> | null = null;

/** One passkey smart-account kit per browser tab, created on first use. */
export function getKit(): Promise<SmartAccountKit> {
  if (!kitPromise) {
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
