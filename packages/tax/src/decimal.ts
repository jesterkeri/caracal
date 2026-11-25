// Exact decimal helpers on bigint. No floats anywhere.

export type Dec = { n: bigint; scale: number }; // value = n / 10^scale

const DEC_RE = /^\d+(\.\d+)?$/;

export function parseDec(s: string): Dec {
  if (typeof s !== "string" || !DEC_RE.test(s.trim())) {
    throw new RangeError(`not a plain non-negative decimal: ${JSON.stringify(s)}`);
  }
  const t = s.trim();
  const [i, f = ""] = t.split(".");
  return { n: BigInt(i + f), scale: f.length };
}

export const pow10 = (k: number): bigint => 10n ** BigInt(k);

/** Divide non-negative n by positive d, rounding half up. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (d * 2n);
}

/** Convert a Dec to integer kobo (2 dp), rounding half up. */
export function toKobo(x: Dec): bigint {
  if (x.scale <= 2) return x.n * pow10(2 - x.scale);
  return divRoundHalfUp(x.n, pow10(x.scale - 2));
}

/** a * b, as kobo, rounded half up once at the end. */
export function mulToKobo(a: Dec, b: Dec): bigint {
  return toKobo({ n: a.n * b.n, scale: a.scale + b.scale });
}

/** kobo * rate, as kobo, rounded half up. */
export function koboTimesRate(kobo: bigint, rate: Dec): bigint {
  return divRoundHalfUp(kobo * rate.n, pow10(rate.scale));
}

export function formatKobo(k: bigint): string {
  const neg = k < 0n;
  const a = neg ? -k : k;
  const s = a.toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Format n/d as a decimal with `dp` places, rounding half up, non-negative n and positive d. */
export function formatRatio(n: bigint, d: bigint, dp: number): string {
  const scaled = divRoundHalfUp(n * pow10(dp), d);
  const s = scaled.toString().padStart(dp + 1, "0");
  return dp === 0 ? s : `${s.slice(0, -dp)}.${s.slice(-dp)}`;
}
