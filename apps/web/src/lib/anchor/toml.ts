import { ANCHOR } from "./config";
import { AnchorError } from "./errors";

/** What Caracal needs from the anchor's stellar.toml. */
export type AnchorToml = {
  signingKey: string;
  webAuthEndpoint: string;
  transferServer: string;
  webAuthContract: string;
};

/** Top-level `KEY = "value"` lines only (the toml's tables hold nothing used here). */
export function parseTopLevel(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // first table: the top level is over
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** An https address on the anchor's own domain, or null. */
function onAnchorDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === ANCHOR.homeDomain && !u.username && !u.password ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Read and check the anchor's stellar.toml. The wallet signs a challenge only
 * for the web auth contract pinned in config, and every endpoint must be an
 * https address on the anchor's own domain.
 */
export function readToml(text: string): AnchorToml {
  const t = parseTopLevel(text);
  const webAuthEndpoint = onAnchorDomain(t.WEB_AUTH_FOR_CONTRACTS_ENDPOINT);
  const transferServer = onAnchorDomain(t.TRANSFER_SERVER_SEP0024);
  const signingKey = t.SIGNING_KEY;
  if (!webAuthEndpoint) throw new AnchorError("The test anchor does not list a sign-in address for smart wallets (SEP-45), so Caracal cannot sign in to it.", "anchor-info");
  if (!transferServer) throw new AnchorError("The test anchor does not list a cash-out address (SEP-24), so Caracal cannot start a cash-out.", "anchor-info");
  if (!signingKey || !/^G[A-Z2-7]{55}$/.test(signingKey)) throw new AnchorError("The test anchor's details do not include a valid signing key, so Caracal cannot check its sign-in challenge.", "anchor-info");
  if (t.WEB_AUTH_CONTRACT_ID !== ANCHOR.webAuthContract) {
    throw new AnchorError("The test anchor's sign-in contract is not the one Caracal expects. Nothing was signed. Try again later, and tell the Caracal team if it keeps happening.", "anchor-info");
  }
  return { signingKey, webAuthEndpoint, transferServer, webAuthContract: t.WEB_AUTH_CONTRACT_ID };
}

/** Fetch and read the toml. */
export async function loadToml(fetchFn: typeof fetch = fetch): Promise<AnchorToml> {
  let res: Response;
  try {
    res = await fetchFn(ANCHOR.tomlUrl, { cache: "no-store" });
  } catch {
    throw new AnchorError("Caracal could not reach the test anchor to read its details. Check your connection and try again.", "anchor-info");
  }
  if (!res.ok) throw new AnchorError(`The test anchor's details page answered with an error (${res.status}). Try again in a minute.`, "anchor-info");
  return readToml(await res.text());
}
