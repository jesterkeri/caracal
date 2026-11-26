// The name a person types on /wallet, made safe for the passkey prompt.

/**
 * The name is sent to the kit, which puts it inside the passkey's user id
 * (with a timestamp and a random number, about 34 more bytes). WebAuthn allows
 * at most 64 bytes there, so a long name would make the passkey prompt fail.
 * It is cut to whole characters within this many UTF-8 bytes.
 */
const NAME_MAX_BYTES = 24;

/** The name typed on /wallet, as the kit is given it: trimmed, within NAME_MAX_BYTES, never empty. */
export function passkeyName(typed: string): string {
  let out = "";
  let bytes = 0;
  for (const ch of typed.trim()) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > NAME_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out.trim() || "Caracal user";
}
