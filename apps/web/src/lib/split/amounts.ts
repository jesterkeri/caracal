// USDC amounts and split percentages, typed by a person and checked before any
// passkey prompt. USDC on Stellar has 7 decimals: 1 USDC is 10,000,000 stroops.

export const USDC_DECIMALS = 7;
const ONE = BigInt(10) ** BigInt(USDC_DECIMALS);
/** Most whole digits accepted: far above any real balance, and well inside the contract's i128. */
const MAX_WHOLE_DIGITS = 12;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** "12.5" to 125000000 stroops. Rejects empty, zero, negative, more than 7 decimals and anything that is not a plain number. */
export function parseUsdc(text: string): Parsed<bigint> {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter an amount in USDC." };
  const m = new RegExp(`^(\\d{1,${MAX_WHOLE_DIGITS}})(?:\\.(\\d*))?$`).exec(t);
  if (!m) return { ok: false, message: "Enter the amount as a plain number, like 25 or 12.50." };
  const fraction = m[2] ?? "";
  if (fraction.length > USDC_DECIMALS) return { ok: false, message: `USDC has at most ${USDC_DECIMALS} decimal places.` };
  const stroops = BigInt(m[1]) * ONE + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
  if (stroops <= BigInt(0)) return { ok: false, message: "The amount must be more than zero." };
  return { ok: true, value: stroops };
}

/** Stroops to a USDC text with at least 2 and at most 7 decimals: 125000000 is "12.50". */
export function formatUsdc(stroops: bigint): string {
  const negative = stroops < BigInt(0);
  const abs = negative ? -stroops : stroops;
  const whole = abs / ONE;
  const fraction = (abs % ONE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/** "10" or "12.5" percent to basis points (1000, 1250). At most 2 decimals, 0 to 100. */
export function parsePercent(text: string, what: string): Parsed<number> {
  const t = text.trim();
  if (t === "") return { ok: false, message: `Enter the ${what} percentage.` };
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return { ok: false, message: `The ${what} percentage must be a number like 10 or 12.5.` };
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps > 10_000) return { ok: false, message: `The ${what} percentage cannot be more than 100.` };
  return { ok: true, value: bps };
}

/** The contract's own bound (BpsTooHigh), checked first so nobody is sent to a passkey prompt for a refusal. */
export function splitProblem(taxBps: number, goalBps: number): string | null {
  if (!Number.isInteger(taxBps) || !Number.isInteger(goalBps) || taxBps < 0 || goalBps < 0) return "The percentages must be whole basis points.";
  if (taxBps + goalBps > 10_000) return "Tax and goal together cannot be more than 100%. Spend gets what is left.";
  return null;
}

/** Basis points as a percentage text: 1250 is "12.5". */
export function bpsText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}
