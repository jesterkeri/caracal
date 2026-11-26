// Submits the relay's signed transaction to OpenZeppelin Channels through the
// official client (@openzeppelin/relayer-plugin-channels, pinned at 0.21.1),
// which wraps it in a fee bump. Server only.
//
// The wallet kit expects { success, data: { transactionId, hash, status } }.
// Anything Channels answers that does not carry a transaction hash (an empty
// body, an HTML error page, a refusal, a timeout) becomes a clear error,
// because without a hash nobody can tell whether the payment happened.

import {
  ChannelsClient,
  PluginExecutionError,
  PluginTransportError,
  PluginUnexpectedError,
} from "@openzeppelin/relayer-plugin-channels/dist/client";

export const DEFAULT_CHANNELS = "https://channels.openzeppelin.com/testnet";

export type Submitter = Pick<ChannelsClient, "submitTransaction">;
export type Submitted =
  | { ok: true; data: { transactionId: string | null; hash: string; status: string } }
  | { ok: false; status: number; error: string };

export function channelsClient(apiKey: string, baseUrl = DEFAULT_CHANNELS, timeoutMs = 60_000): Submitter {
  return new ChannelsClient({ baseUrl, apiKey, timeout: timeoutMs });
}

/** An error code Channels sends (e.g. ONCHAIN_FAILED), if it looks like one. Never free text. */
function codeOf(details: unknown): string | null {
  const code = (details as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

export async function submitToChannels(client: Submitter, xdr: string): Promise<Submitted> {
  try {
    const r = await client.submitTransaction({ xdr });
    if (typeof r?.hash !== "string" || r.hash === "") {
      console.error("channels answered without a transaction hash:", JSON.stringify(r).slice(0, 200));
      return { ok: false, status: 502, error: "The fee relayer gave no transaction result. Check your activity before trying again." };
    }
    return { ok: true, data: { transactionId: r.transactionId ?? null, hash: r.hash, status: r.status ?? "submitted" } };
  } catch (e) {
    if (e instanceof PluginExecutionError) {
      const code = codeOf(e.errorDetails);
      console.error("channels refused the transaction:", code ?? e.message.slice(0, 200));
      return { ok: false, status: 502, error: `The fee relayer refused this transaction${code ? ` (${code})` : ""}.` };
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
