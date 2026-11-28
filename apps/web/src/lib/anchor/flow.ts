import { rpc } from "@stellar/stellar-sdk";
// The two steps of a cash-out that need the wallet, with their dependencies
// passed in so they are tested without a browser, a passkey or a network.

import { AnchorError, RequestTimeout, messageOf, within } from "./errors";
import { signInToAnchor, type Sep45Deps } from "./sep45";
import { startWithdraw, type AnchorTxn } from "./sep24";
import { UnboundedPayment } from "./send-guard";
import { paymentFor, type AnchorPayment } from "./transfer";
import type { AnchorToml } from "./toml";

/** smart-account-kit error codes used here (SmartAccountErrorCode). */
const WEBAUTHN_CANCELLED = 4004;
const TRANSACTION_TIMEOUT = 5004;

/**
 * Failures the kit raises before it submits anything (the passkey or the
 * signing step): WebAuthn 4001 to 4004, simulation 5001, signing 5002, and a
 * contract error (10000, CONTRACT_ERROR). The kit makes a ContractError only by
 * finding "Error(Contract, #N)" in a diagnostic: its own simulations before the
 * send, or the relay's answer. Caracal's relay never puts that text in an
 * answer (its refusals are fixed texts and a Channels failure is reduced to its
 * code, src/lib/relay/channels.ts), and a failure the network confirmed comes
 * with a hash, which is not treated as unsent. So one with no hash is the
 * kit's own check before sending.
 */
const BEFORE_SUBMIT = new Set([4001, 4002, 4003, 4004, 5001, 5002, 10000]);

/**
 * Longest wait for the passkey, the relay and the kit's confirmation poll together. The kit polls on an RPC
 * client with no timeout of its own; past this the payment may still land, so the outcome is unknown.
 */
export const SEND_TIMEOUT_MS = 5 * 60_000;

/**
 * "Not sent" needs proof: the relay's own refusal text ("Nothing was sent",
 * which it says only for refusals made before it sent anything), or a failure
 * the kit raised before submitting. A relay that did not answer (code 5003
 * with no hash) is not proof.
 */
function provenNotSent(code: number | undefined, message: string): boolean {
  if (/Nothing was sent/i.test(message)) return true;
  return code !== undefined && BEFORE_SUBMIT.has(code);
}

const codeOf = (e: unknown): number | undefined => (typeof e === "object" && e !== null ? (e as { code?: number }).code : undefined);

export type BeginResult = { token: string; id: string; url: string };

/** Sign in to the anchor (one passkey confirmation) and start the interactive withdraw. Nothing is sent yet. */
export async function beginCashout(wallet: string, toml: AnchorToml, amount: bigint, deps: Sep45Deps): Promise<BeginResult> {
  let token: string;
  try {
    token = await signInToAnchor(wallet, toml, deps);
  } catch (e) {
    if (e instanceof AnchorError) throw e;
    if (codeOf(e) === WEBAUTHN_CANCELLED) throw new AnchorError("You cancelled the passkey prompt, so Caracal did not sign in to the anchor. Nothing was started.", "sign-in");
    // The passkey and network steps name themselves (sep45.ts); anything else is not put down to either.
    console.error("anchor sign-in failed:", messageOf(e));
    throw new AnchorError("Caracal could not sign in to the anchor. Nothing was started. Try again.", "sign-in");
  }
  const started = await startWithdraw(toml.transferServer, token, wallet, amount, deps.fetchFn);
  return { token, ...started };
}

export type SendResult =
  | { kind: "sent"; hash: string }
  /** The payment may still have gone through. The anchor's status is the truth: keep watching it. */
  | { kind: "unknown"; hash?: string; message: string }
  /** Not sent, and nothing left the wallet. */
  | { kind: "not-sent"; message: string };

export type SendDeps = {
  /** Builds and simulates the transfer (needs the network). */
  buildTransfer(payment: AnchorPayment): Promise<unknown>;
  /** The kit's signAndSubmit: passkey, then the relay pays the fee and submits. */
  signAndSubmit(tx: unknown): Promise<{ success: true; hash: string } | { success: false; hash?: string; error: { code?: number; message: string } }>;
  /**
   * Asked just before the passkey: why the record confirmed at the press may no longer be the one to pay
   * (the anchor changed it, or stopped waiting for USDC, while the balance was read and the payment built),
   * or null to go on (adversary c23). It may read the anchor again (adversary c41); a check that throws sends nothing.
   */
  stillCurrent?(): string | null | Promise<string | null>;
};

const EXPIRED_STATE =
  "Data this payment needs on Stellar testnet (your wallet or its USDC balance) has expired and must be restored before it can pay. Caracal cannot restore it yet, so nothing was sent, and trying again will not help.";

const WALLET_NOT_FOUND =
  "The fee relay could not find your wallet on Stellar testnet, so nothing was sent. A wallet not used for a long time may have expired and need restoring, which Caracal cannot do yet, so trying again will not help.";

/** Whether a built transaction's simulation asks for a restore first. */
function needsRestore(tx: unknown): boolean {
  const sim = (tx as { simulation?: unknown } | null)?.simulation;
  return typeof sim === "object" && sim !== null && rpc.Api.isSimulationRestore(sim as rpc.Api.SimulateTransactionResponse);
}

/** Send exactly the amount the person confirmed, once, to the anchor's account. */
export async function sendToAnchor(txn: AnchorTxn, confirmed: bigint, deps: SendDeps): Promise<SendResult> {
  let payment: AnchorPayment;
  try {
    payment = paymentFor(txn, confirmed);
  } catch (e) {
    return { kind: "not-sent", message: e instanceof AnchorError ? e.message : "Caracal could not check the anchor's request. Nothing was sent." };
  }
  let tx: unknown;
  try {
    tx = await deps.buildTransfer(payment);
  } catch (e) {
    return { kind: "not-sent", message: e instanceof AnchorError ? e.message : "Caracal could not prepare the USDC payment. Nothing was sent. Try again." };
  }
  // Data the payment needs (the wallet, or its USDC balance entry) has expired: the simulation asks for a restore,
  // which the kit refuses before sending and the relay does not pay for yet, so retrying cannot help (adversary c17).
  if (needsRestore(tx)) return { kind: "not-sent", message: EXPIRED_STATE };
  let stale: string | null;
  try {
    stale = (await deps.stillCurrent?.()) ?? null;
  } catch {
    stale = "Caracal could not check the anchor's latest record of this withdrawal, so nothing was sent. Try again in a moment.";
  }
  if (stale !== null) return { kind: "not-sent", message: stale };
  let r: Awaited<ReturnType<SendDeps["signAndSubmit"]>>;
  try {
    r = await within(deps.signAndSubmit(tx), SEND_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof RequestTimeout) {
      return { kind: "unknown", message: "Caracal got no answer about the USDC payment within 5 minutes. It may still go through. The anchor's status below shows whether it arrived. Do not send it again." };
    }
    if (codeOf(e) === WEBAUTHN_CANCELLED) return { kind: "not-sent", message: "You cancelled the passkey prompt. Nothing was sent." };
    // Refused by the send guard before the kit was called (send-guard.ts submit).
    if (e instanceof UnboundedPayment) return { kind: "not-sent", message: e.message };
    console.error("USDC payment threw:", messageOf(e));
    return { kind: "unknown", message: "Something went wrong while sending the USDC and Caracal cannot tell whether it left your wallet. The anchor's status below shows whether it arrived. Do not send it again." };
  }
  if (r.success) return { kind: "sent", hash: r.hash };
  if (r.error.code === WEBAUTHN_CANCELLED) return { kind: "not-sent", message: "You cancelled the passkey prompt. Nothing was sent." };
  console.error("USDC payment failed:", r.error.message);
  const code = r.error.code;
  // The relay's report that the network ran the payment and it failed (src/lib/relay/channels.ts, ONCHAIN_FAILED).
  if (/This transaction failed on the network \(ONCHAIN_FAILED\), so nothing changed\./.test(r.error.message)) {
    return { kind: "not-sent", message: "The USDC payment failed on the network, so nothing left your wallet. Try again." };
  }
  if (!r.hash && code !== TRANSACTION_TIMEOUT && provenNotSent(code, r.error.message)) {
    // The first simulation runs without signatures, so it cannot see the wallet's own expired data (its
    // instance, rules or verifier, read only by __check_auth). The signed re-simulation and the relay can: the
    // relay then refuses with its restore text (src/lib/relay/sponsor.ts, policy.ts), and the kit's own
    // re-simulation may name the expired state. Retrying cannot help (adversary c21).
    if (/must be restored first|ExpiredState|archived/i.test(r.error.message)) return { kind: "not-sent", message: EXPIRED_STATE };
    if (/may need restoring/i.test(r.error.message)) return { kind: "not-sent", message: WALLET_NOT_FOUND };
    return { kind: "not-sent", message: "The USDC payment was not sent. Nothing left your wallet. Try again." };
  }
  // Everything else is unknown: a relay that did not answer (5003 with no hash) may have passed the payment on.
  return { kind: "unknown", hash: r.hash, message: "Caracal could not confirm the USDC payment. It may still go through. The anchor's status below shows whether it arrived. Do not send it again." };
}
