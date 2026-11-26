// The wording of the relay's refusals made before anything is sent upstream.

/**
 * A refusal before anything was sent upstream always says "Nothing was sent":
 * that phrase is the only part of the answer the wallet kit hands on to the
 * page, and the page offers wallet creation again only when it is there (any
 * other failure may have created the wallet). A closing "Try again." stays last.
 */
export function refusalText(error: string): string {
  if (error.includes("Nothing was sent")) return error;
  const base = error.trim().replace(/[.]?$/, ".");
  const retry = " Try again.";
  return base.endsWith(retry) ? `${base.slice(0, -retry.length)} Nothing was sent.${retry}` : `${base} Nothing was sent.`;
}
