// The invoice reference: an opaque id the app generates. It is the only thing
// about an invoice that goes on chain next to the amount (contracts/split:
// 1 to 64 bytes). Names and descriptions never leave the freelancer's account.

import { Buffer } from "buffer";

export const REF_BYTES = 16;
const MAX_REF_BYTES = 64;

/** A new random reference: 16 random bytes as 32 lowercase hex characters. */
export function newInvoiceRef(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return Buffer.from(random(new Uint8Array(REF_BYTES))).toString("hex");
}

/** The reference's bytes, or null if `text` is not 1 to 64 bytes of lowercase hex. */
export function refBytes(text: string): Buffer | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_REF_BYTES * 2 || !/^(?:[0-9a-f]{2})+$/.test(text)) return null;
  return Buffer.from(text, "hex");
}

/** The pay page's path for an invoice: the split contract and the reference, nothing else. */
export function payPath(split: string, ref: string): string {
  return `/pay/${split}/${ref}`;
}
