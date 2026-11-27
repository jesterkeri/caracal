// USDC amounts. Testnet USDC has 7 decimals; the contract takes whole stroops.

const DECIMALS = 7;
const SCALE = BigInt(10) ** BigInt(DECIMALS);
/** Largest amount accepted when typed: 1 billion USDC, far below i128 and any real invoice. */
const MAX_STROOPS = BigInt(1_000_000_000) * SCALE;

/** "12.5" to 125000000n. Null unless it is a plain positive amount with at most 7 decimals. */
export function parseUsdc(text: string): bigint | null {
  const m = /^(\d{1,10})(?:\.(\d{1,7}))?$/.exec(text.trim());
  if (!m) return null;
  const stroops = BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(DECIMALS, "0"));
  return stroops > BigInt(0) && stroops <= MAX_STROOPS ? stroops : null;
}

/** 125000000n to "12.50": at least 2 decimals, up to 7, so every stroop is shown. */
export function formatUsdc(stroops: bigint): string {
  const whole = stroops / SCALE;
  const frac = (stroops % SCALE).toString().padStart(DECIMALS, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}
