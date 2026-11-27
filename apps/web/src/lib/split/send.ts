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
//   refused  Caracal's relay said "Nothing was sent".
//   stopped  it failed before anything reached the relay (the passkey prompt
//            was closed, the call was refused when simulated).
//   unknown  anything else: it may or may not have landed. The page re-reads
//            the chain instead of guessing.

import { contract, rpc, Operation, type xdr } from "@stellar/stellar-sdk";
import type { TransactionResult } from "smart-account-kit";
import { splitErrorText } from "./errors";

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
  if (tx.simulation && rpc.Api.isSimulationError(tx.simulation)) throw new Error(splitErrorText(tx.simulation.error));
  return tx;
};

/** Failures the kit raises only before it posts anything to the relay (signing and re-simulation come first). */
const BEFORE_SENDING = new Set(["WebAuthnError", "WalletNotConnectedError", "SignerNotFoundError", "CredentialNotFoundError", "ValidationError", "SimulationError"]);
/** What a closed or timed-out passkey prompt raises in the browser. */
const PROMPT_CLOSED = new Set(["NotAllowedError", "AbortError"]);

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
  try {
    tx = await build(kit, func, method, contractId);
  } catch (e) {
    // Nothing has been signed or posted yet.
    return { kind: "stopped", message: `The call was refused when Caracal tried it first: ${problem(e)}` };
  }
  let result: TransactionResult;
  try {
    result = await kit.signAndSubmit(tx);
  } catch (e) {
    return { kind: "unknown", message: problem(e) };
  }
  if (result.success) return { kind: "done", hash: result.hash };
  const err = result.error;
  const message = problem(err);
  const hash = typeof result.hash === "string" && result.hash !== "" ? result.hash : undefined;
  if (!hash && message.includes("Nothing was sent")) return { kind: "refused", message };
  const cause = (err as { cause?: unknown }).cause;
  if (!hash && cause instanceof Error && PROMPT_CLOSED.has(cause.name)) {
    return { kind: "stopped", message: "The passkey prompt was closed or timed out." };
  }
  if (!hash && BEFORE_SENDING.has(err.name)) return { kind: "stopped", message };
  return { kind: "unknown", message, hash };
}
