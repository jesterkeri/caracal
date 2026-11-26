// Submits the relay's signed transaction to OpenZeppelin Channels through the
// official client (@openzeppelin/relayer-plugin-channels, pinned at 0.21.1),
// which wraps it in a fee bump. Server only.
//
// The wallet kit expects { success, data: { transactionId, hash, status } },
// and gets success only for a transaction Channels reports as confirmed.
// Anything Channels answers that does not carry a transaction hash (an empty
// body, an HTML error page, a refusal, a timeout) becomes a clear error,
// because without a hash nobody can tell whether the payment happened.

import {
  ChannelsClient,
  PluginExecutionError,
  PluginTransportError,
  PluginUnexpectedError,
} from "@openzeppelin/relayer-plugin-channels/dist/client";
import { within } from "./sponsor";

export const DEFAULT_CHANNELS = "https://channels.openzeppelin.com/testnet";

export type Submitter = Pick<ChannelsClient, "submitTransaction">;
export type Submitted =
  | { ok: true; data: { transactionId: string | null; hash: string; status: string } }
  | { ok: false; status: number; error: string };

export function channelsClient(apiKey: string, baseUrl = DEFAULT_CHANNELS, timeoutMs = 60_000): Submitter {
  return new ChannelsClient({ baseUrl, apiKey, timeout: timeoutMs });
}

/**
 * Channels codes (plugin 0.21.1) raised by checks that run before the
 * transaction is sent, so nothing reached the network. Any other code,
 * including WAIT_TIMEOUT, may come after sending, so the user is told to
 * check before retrying. Re-check this list when upgrading the plugin.
 */
const REFUSED_BEFORE_SUBMIT: ReadonlySet<string> = new Set([
  "API_KEY_REQUIRED", "UNAUTHORIZED", "UNSUPPORTED_NETWORK", "INVALID_PARAMS", "INVALID_PAYLOAD",
  "INVALID_ENVELOPE_TYPE", "INVALID_UNSIGNED_XDR", "INVALID_SIGNATURE", "TIMEBOUNDS_EXPIRED", "TIMEBOUNDS_TOO_FAR",
  "FEE_LIMIT_EXCEEDED", "FEE_MISMATCH", "AUTH_EXPIRY_TOO_SHORT", "SIMULATION_FAILED",
  "SIMULATION_SIGNED_AUTH_VALIDATION_FAILED", "ASSEMBLY_FAILED", "NO_CHANNELS_CONFIGURED", "POOL_CAPACITY",
]);

/** An error code Channels sends (e.g. ONCHAIN_FAILED), if it looks like one. Never free text. */
export function codeOf(details: unknown): string | null {
  const code = (details as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

/**
 * `deadlineMs` bounds the whole call. The client's own timeout only fires when
 * the connection goes idle, so an answer that trickles in forever would
 * otherwise hold the relay's one-at-a-time queue. The default (60 s) is above
 * the transaction's validity (TX_TIMEOUT_S, 25 s), so a call abandoned here can
 * no longer land on chain. With a shorter CHANNELS_TIMEOUT_MS it might, and the
 * next transaction can then be refused for a stale sequence number (the user
 * is told to check and retry; nothing is paid twice).
 */
export async function submitToChannels(client: Submitter, xdr: string, deadlineMs = 60_000): Promise<Submitted> {
  try {
    const r = await within(client.submitTransaction({ xdr }), deadlineMs, "channels submitTransaction");
    if (typeof r?.hash !== "string" || r.hash === "") {
      console.error("channels answered without a transaction hash:", JSON.stringify(r).slice(0, 200));
      return { ok: false, status: 502, error: "The fee relayer gave no transaction result. Check your activity before trying again." };
    }
    // Plugin 0.21.1 throws only for "failed"; any other final status (expired,
    // canceled, or one added later) is passed on as a success. Only a
    // confirmed transaction is reported as done.
    if (r.status !== "confirmed") {
      const status = typeof r.status === "string" && /^[a-z_]{1,20}$/.test(r.status) ? r.status : null;
      console.error("channels answered a hash without confirmation:", r.hash, status ?? "");
      return {
        ok: false,
        status: 502,
        error: `The fee relayer did not confirm this transaction${status ? ` (status: ${status})` : ""}. Check your activity before trying again.`,
      };
    }
    return { ok: true, data: { transactionId: r.transactionId ?? null, hash: r.hash, status: r.status } };
  } catch (e) {
    if (e instanceof PluginExecutionError) {
      const code = codeOf(e.errorDetails);
      console.error("channels did not complete the transaction:", code ?? "", e.message.slice(0, 200));
      if (code === "ONCHAIN_FAILED") {
        // It reached the ledger and failed, so it changed nothing.
        return { ok: false, status: 502, error: "This transaction failed on the network (ONCHAIN_FAILED), so nothing changed." };
      }
      if (code && REFUSED_BEFORE_SUBMIT.has(code)) {
        return { ok: false, status: 502, error: `The fee relayer refused this transaction (${code}). Nothing was sent.` };
      }
      // WAIT_TIMEOUT ("it may still submit"), an unknown code or none: it may have been sent.
      return { ok: false, status: 502, error: `The fee relayer could not confirm this transaction${code ? ` (${code})` : ""}. Check your activity before trying again.` };
    }
    if (e instanceof PluginTransportError) {
      console.error("channels transport error:", e.statusCode ?? "", e.message.slice(0, 200));
      if (e.statusCode === 429) return { ok: false, status: 429, error: "The fee sponsor is busy. Try again shortly." };
      // A timeout may come after Channels already submitted the transaction.
      return { ok: false, status: 502, error: "The fee relayer did not answer. Check your activity before trying again." };
    }
    if (e instanceof PluginUnexpectedError) {
      console.error("channels unreadable answer:", e.message.slice(0, 200));
      return { ok: false, status: 502, error: "The fee relayer gave an answer Caracal could not read. Check your activity before trying again." };
    }
    console.error("channels submit failed:", e instanceof Error ? e.message : String(e));
    return { ok: false, status: 502, error: "The fee relayer did not answer. Check your activity before trying again." };
  }
}
