// The two steps of a cash-out that need the wallet, with their dependencies
// passed in so they are tested without a browser, a passkey or a network.

import { AnchorError, messageOf } from "./errors";
import { signInToAnchor, type Sep45Deps } from "./sep45";
import { startWithdraw, type AnchorTxn } from "./sep24";
import { paymentFor, type AnchorPayment } from "./transfer";
import type { AnchorToml } from "./toml";

/** smart-account-kit error codes used here (SmartAccountErrorCode). */
const WEBAUTHN_CANCELLED = 4004;
const TRANSACTION_TIMEOUT = 5004;

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
    console.error("anchor sign-in failed:", messageOf(e));
    throw new AnchorError("Your passkey could not sign the anchor's sign-in. Nothing was started. Try again.", "sign-in");
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
};

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
  let r: Awaited<ReturnType<SendDeps["signAndSubmit"]>>;
  try {
    r = await deps.signAndSubmit(tx);
  } catch (e) {
    if (codeOf(e) === WEBAUTHN_CANCELLED) return { kind: "not-sent", message: "You cancelled the passkey prompt. Nothing was sent." };
    console.error("USDC payment threw:", messageOf(e));
    return { kind: "unknown", message: "Something went wrong while sending the USDC and Caracal cannot tell whether it left your wallet. The anchor's status below shows whether it arrived. Do not send it again." };
  }
  if (r.success) return { kind: "sent", hash: r.hash };
  if (r.error.code === WEBAUTHN_CANCELLED) return { kind: "not-sent", message: "You cancelled the passkey prompt. Nothing was sent." };
  console.error("USDC payment failed:", r.error.message);
  if (r.hash || r.error.code === TRANSACTION_TIMEOUT) {
    return { kind: "unknown", hash: r.hash, message: "Caracal could not confirm the USDC payment. It may still go through. The anchor's status below shows whether it arrived. Do not send it again." };
  }
  return { kind: "not-sent", message: "The USDC payment was not sent. Nothing left your wallet. Try again." };
}
