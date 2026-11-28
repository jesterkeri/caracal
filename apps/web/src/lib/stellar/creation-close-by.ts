// Sends a wallet creation's last ledger to the fee relay with the creation itself.

import { CLOSE_BY_PARAM } from "../relay/deploy-auth";

/**
 * Runs `run` (a wallet creation) with the kit's relayer requests naming
 * `closeBy`, the last ledger in which the page allows the creation to land
 * (deploy-auth.ts CLOSE_BY_PARAM): the relay caps the deployment's
 * authorisation at it, so the page knows the bound even if the answer is lost.
 * smart-account-kit 0.10.0's RelayerClient posts to its `url` field, which
 * deploy-ops reads at send time; it is put back afterwards. Throws, before
 * anything is sent, if the relayer has no such field.
 */
export async function withCreationCloseBy<T>(kit: { relayer?: unknown }, closeBy: number, run: () => Promise<T>): Promise<T> {
  const relayer = kit.relayer as { url?: unknown } | null | undefined;
  // No relayer: the kit refuses a shared-deployer creation before sending (deploy-ops sharedDeployerFeeError).
  if (relayer === null || relayer === undefined) return run();
  if (typeof relayer.url !== "string") {
    throw new Error("Caracal could not attach the creation's last ledger to the fee sponsor request. Nothing was sent.");
  }
  const base = relayer.url;
  relayer.url = `${base}${base.includes("?") ? "&" : "?"}${CLOSE_BY_PARAM}=${closeBy}`;
  try {
    return await run();
  } finally {
    relayer.url = base;
  }
}
