// Sending one split write (deploy, withdraw, move, change split) through the
// person's passkey wallet and Caracal's fee relay.
//
// The path is smart-account-kit 0.10.0's own: the call is simulated once to
// find the authorisation the wallet must give, kit.signAndSubmit has the
// passkey sign it, re-simulates with the signature, and posts { func, auth }
// to /api/relay (the kit's relayerUrl), which sponsors the fee and submits.
// The auth is the wallet's own (a direct call, not the wallet's `execute`).
//
// The outcome says only what is known:
//   done     the network confirmed it.
//   refused  Caracal's relay said "Nothing was sent", or that the network ran it and it failed, so nothing changed (ONCHAIN_FAILED).
//   stopped  it failed before anything reached the relay (the passkey prompt
//            was closed, the call was refused when simulated, or the network
//            did not answer the first simulation within its limit).
//   unknown  anything else: it may or may not have landed. The page re-reads
//            the chain instead of guessing.

import { contract, rpc, Operation, type xdr } from "@stellar/stellar-sdk";
import type { TransactionResult } from "smart-account-kit";
import { splitErrorText } from "./errors";
import { READ_TIMEOUT_MS } from "./chain";

/** The network answered and said the call fails (a simulation error), as opposed to not answering. */
export class SimulationRefused extends Error {}

/** The part of smart-account-kit's SmartAccountKit used to write. */
export type WriteKit = {
  rpc: unknown;
  rpcUrl: string;
  networkPassphrase: string;
  signAndSubmit(tx: contract.AssembledTransaction<unknown>): Promise<TransactionResult>;
};

export type SendOutcome =
  | { kind: "done"; hash: string }
  | { kind: "refused"; message: string }
  | { kind: "stopped"; message: string }
  | { kind: "unknown"; message: string; hash?: string };

/** Builds and simulates the transaction for a host function. Replaceable in tests. */
export type BuildTx = (kit: WriteKit, func: xdr.HostFunction, method: string, contractId: string) => Promise<contract.AssembledTransaction<unknown>>;

export const buildTx: BuildTx = async (kit, func, method, contractId) => {
  const tx = await contract.AssembledTransaction.buildWithOp<unknown>(Operation.invokeHostFunction({ func, auth: [] }), {
    contractId,
    networkPassphrase: kit.networkPassphrase,
    rpcUrl: kit.rpcUrl,
    server: kit.rpc as rpc.Server,
    method,
    parseResultXdr: (v) => v,
  } as contract.AssembledTransactionOptions<unknown>);
  if (tx.simulation && rpc.Api.isSimulationError(tx.simulation)) throw new SimulationRefused(splitErrorText(tx.simulation.error));
  return tx;
};

/** Failures the kit raises only before it posts anything to the relay (signing and re-simulation come first). */
const BEFORE_SENDING = new Set(["WebAuthnError", "WalletNotConnectedError", "SignerNotFoundError", "CredentialNotFoundError", "ValidationError", "SimulationError"]);
/** What a closed or timed-out passkey prompt raises in the browser. */
const PROMPT_CLOSED = new Set(["NotAllowedError", "AbortError"]);

/** Longest wait for the passkey prompt plus the relay and the network to answer (a WebAuthn prompt itself times out within this). */
export const SEND_TIMEOUT_MS = 5 * 60_000;

function problem(e: unknown): string {
  return splitErrorText(e instanceof Error ? e.message : String(e));
}

export async function sendSplitCall(
  kit: WriteKit,
  func: xdr.HostFunction,
  method: string,
  contractId: string,
  build: BuildTx = buildTx,
): Promise<SendOutcome> {
  let tx: contract.AssembledTransaction<unknown>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The first simulation has the same limit as every read: an RPC that never answers ends the write here.
    tx = await Promise.race([
      build(kit, func, method, contractId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the Stellar network did not answer within ${READ_TIMEOUT_MS / 1000} seconds`)), READ_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    // Nothing has been signed or posted yet. A refusal by the contract is named as one;
    // anything else is the network not answering, not the call being refused.
    const refusedByChain = e instanceof SimulationRefused || (e instanceof Error && /Error\(Contract,/.test(e.message));
    return refusedByChain
      ? { kind: "stopped", message: `The call was refused when Caracal tried it first: ${problem(e)}` }
      : { kind: "stopped", message: `Caracal could not reach the Stellar network to prepare this, so nothing was signed or sent. Check your connection and try again. (${problem(e)})` };
  } finally {
    clearTimeout(timer);
  }
  let result: TransactionResult;
  let late: ReturnType<typeof setTimeout> | undefined;
  try {
    // The kit re-simulates and polls on an RPC client with no timeout of its own, so the whole send has a
    // limit too. Once it has passed the write may still land: the outcome is unknown, never "not sent".
    result = await Promise.race([
      kit.signAndSubmit(tx),
      new Promise<never>((_, reject) => {
        late = setTimeout(() => reject(new Error(`no answer within ${SEND_TIMEOUT_MS / 60_000} minutes`)), SEND_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    return { kind: "unknown", message: problem(e) };
  } finally {
    clearTimeout(late);
  }
  if (result.success) return { kind: "done", hash: result.hash };
  const err = result.error;
  const message = problem(err);
  const hash = typeof result.hash === "string" && result.hash !== "" ? result.hash : undefined;
  if (!hash && message.includes("Nothing was sent")) return { kind: "refused", message };
  // The relay's report that the network ran the transaction and it failed (src/lib/relay/channels.ts, ONCHAIN_FAILED):
  // certain, and nothing changed, so it is a refusal in the page's words, not an unknown.
  if (/This transaction failed on the network \(ONCHAIN_FAILED\), so nothing changed\./.test(message)) return { kind: "refused", message };
  const cause = (err as { cause?: unknown }).cause;
  if (!hash && cause instanceof Error && PROMPT_CLOSED.has(cause.name)) {
    return { kind: "stopped", message: "The passkey prompt was closed or timed out." };
  }
  if (!hash && BEFORE_SENDING.has(err.name)) return { kind: "stopped", message };
  return { kind: "unknown", message, hash };
}
