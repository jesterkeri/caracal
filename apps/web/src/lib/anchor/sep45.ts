// SEP-45: sign in to the anchor as a smart contract account (the passkey wallet).
// Proven live against testanchor.stellar.org on 2026-11-27 (docs/research/anchor-spike-2026-11-27.md).
//
// 1. GET  <web auth endpoint>?account=C...&home_domain=...  gives two authorization
//    entries for web_auth_verify: the anchor's (already signed) and the wallet's.
// 2. The wallet signs its own entry with the passkey (the kit's signAuthEntry).
// 3. POST the entries back and receive a token. The token stays in memory:
//    never in a URL, a log or storage.

import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { AnchorError } from "./errors";
import { ANCHOR } from "./config";
import type { AnchorToml } from "./toml";

/** Ledgers the signature stays valid for (about 8 minutes at 5 seconds a ledger). */
export const SIGNATURE_LEDGERS = 100;

export type Sep45Deps = {
  fetchFn: typeof fetch;
  /** The kit's signAuthEntry: asks for the passkey, returns the entry with the wallet's signature. */
  signAuthEntry(entry: xdr.SorobanAuthorizationEntry, options: { expiration: number; contextRuleIds: number[] }): Promise<xdr.SorobanAuthorizationEntry>;
  latestLedger(): Promise<number>;
};

const walletOf = (e: xdr.SorobanAuthorizationEntry): string | null => {
  const c = e.credentials();
  if (c.switch().name !== "sorobanCredentialsAddress") return null;
  try {
    return Address.fromScAddress(c.address().address()).toString();
  } catch {
    return null;
  }
};

/** The 4-byte count then each entry: the XDR of a variable array of authorization entries. */
export function encodeEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(entries.length);
  return Buffer.concat([count, ...entries.map((e) => e.toXDR())]).toString("base64");
}

/**
 * Check the anchor's challenge before the passkey is asked to sign anything,
 * and return the entries and the index of the wallet's own. The wallet signs
 * only a single web_auth_verify call on the pinned web auth contract, for its
 * own address and the anchor's domain, with no sub-calls.
 */
export function checkChallenge(entriesBase64: string, wallet: string, toml: AnchorToml): { entries: xdr.SorobanAuthorizationEntry[]; own: number } {
  let entries: xdr.SorobanAuthorizationEntry[];
  try {
    entries = [...xdr.SorobanAuthorizationEntries.fromXDR(entriesBase64, "base64")];
  } catch {
    throw new AnchorError("The anchor's sign-in challenge could not be read. Nothing was signed.", "sign-in");
  }
  const own = entries.map(walletOf).flatMap((w, i) => (w === wallet ? [i] : []));
  if (own.length !== 1) throw new AnchorError("The anchor's sign-in challenge is not addressed to your wallet. Nothing was signed.", "sign-in");
  for (const e of entries) {
    const root = e.rootInvocation();
    const f = root.function();
    if (f.switch().name !== "sorobanAuthorizedFunctionTypeContractFn" || root.subInvocations().length !== 0) {
      throw new AnchorError("The anchor's sign-in challenge asks for more than a sign-in. Nothing was signed.", "sign-in");
    }
    const call = f.contractFn();
    if (Address.fromScAddress(call.contractAddress()).toString() !== toml.webAuthContract || call.functionName().toString() !== "web_auth_verify" || call.args().length !== 1) {
      throw new AnchorError("The anchor's sign-in challenge is not for its sign-in contract. Nothing was signed.", "sign-in");
    }
    const a = scValToNative(call.args()[0]!) as Record<string, unknown>;
    if (a.account !== wallet || a.home_domain !== ANCHOR.homeDomain || a.web_auth_domain !== ANCHOR.homeDomain || a.web_auth_domain_account !== toml.signingKey) {
      throw new AnchorError("The anchor's sign-in challenge names a different wallet or domain than expected. Nothing was signed.", "sign-in");
    }
  }
  return { entries, own: own[0]! };
}

/** Sign in. Returns the anchor's token. Needs one passkey confirmation. */
export async function signInToAnchor(wallet: string, toml: AnchorToml, deps: Sep45Deps): Promise<string> {
  const query = new URLSearchParams({ account: wallet, home_domain: ANCHOR.homeDomain });
  let challenge: Response;
  try {
    challenge = await deps.fetchFn(`${toml.webAuthEndpoint}?${query}`, { cache: "no-store" });
  } catch {
    throw new AnchorError("Caracal could not reach the test anchor to sign in. Check your connection and try again.", "sign-in");
  }
  if (!challenge.ok) throw new AnchorError(`The test anchor refused to start a sign-in for your wallet (it answered ${challenge.status}). Try again in a minute.`, "sign-in");
  const body: unknown = await challenge.json().catch(() => null);
  const text = typeof body === "object" && body !== null ? (body as Record<string, unknown>).authorization_entries : undefined;
  if (typeof text !== "string") throw new AnchorError("The test anchor's sign-in challenge was not in the expected shape. Nothing was signed.", "sign-in");

  const { entries, own } = checkChallenge(text, wallet, toml);
  const expiration = (await deps.latestLedger()) + SIGNATURE_LEDGERS;
  // Rule 0 is the default rule every Caracal wallet is created with; a
  // web_auth_verify call on another contract falls under its default context.
  entries[own] = await deps.signAuthEntry(entries[own]!, { expiration, contextRuleIds: [0] });

  let answer: Response;
  try {
    answer = await deps.fetchFn(toml.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization_entries: encodeEntries(entries) }),
    });
  } catch {
    throw new AnchorError("Caracal could not reach the test anchor to finish signing in. Check your connection and try again.", "sign-in");
  }
  if (!answer.ok) throw new AnchorError(`The test anchor did not accept the signed sign-in (it answered ${answer.status}). Nothing was started. Try again.`, "sign-in");
  const done: unknown = await answer.json().catch(() => null);
  const token = typeof done === "object" && done !== null ? (done as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || token.length === 0) throw new AnchorError("The test anchor accepted the sign-in but sent no token. Try again.", "sign-in");
  return token;
}
