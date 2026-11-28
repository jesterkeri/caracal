// Reads an answer from another server (the CBN rate list, the Stellar RPC) with a size limit that stops the
// download, not one judged after the whole body is already in memory. Same approach as readBounded in
// src/lib/relay/policy.ts, which bounds what a caller sends to the relay. A refused body's cancellation is started and
// not waited for (Codex tax R6), so a stream whose cancel never settles cannot hold the read.
import { cancelQuietly } from "../cancel-quietly";

/** The body as text, or null once more than `maxBytes` arrive (the rest is not downloaded). */
export async function readLimitedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelQuietly(() => res.body?.cancel());
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      cancelQuietly(() => reader.cancel());
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
