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
  }
  return kitPromise;
}
