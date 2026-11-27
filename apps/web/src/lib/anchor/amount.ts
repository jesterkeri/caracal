// Exact decimal amounts in 7-place stroops. No floating point: a rounding slip
// here would change how much USDC leaves the wallet.

const DECIMAL = /^(\d{1,15})(?:\.(\d{1,7}))?$/;
const SCALE = BigInt(10_000_000);

/** "2", "2.5" or "0.0000001" as stroops; null for anything else (negative, 8 places, text, empty). */
export function toStroops(text: string): bigint | null {
  const m = DECIMAL.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? "").padEnd(7, "0"));
}

/** Stroops as the shortest exact decimal ("2", "2.5", "0.0000001"). */
export function fromStroops(stroops: bigint): string {
  const whole = stroops / SCALE;
  const frac = (stroops % SCALE).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
