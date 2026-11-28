// SEP-45: sign in to the anchor as a smart contract account (the passkey wallet).
// Proven live against testanchor.stellar.org on 2026-11-27 (docs/research/anchor-spike-2026-11-27.md).
//
// 1. GET  <web auth endpoint>?account=C...&home_domain=...  gives two authorization
//    entries for web_auth_verify: the anchor's (already signed) and the wallet's.
// 2. The wallet signs its own entry with the passkey (the kit's signAuthEntry).
// 3. POST the entries back and receive a token. The token stays in memory:
//    never in a URL, a log or storage.

import { Address, Keypair, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { AnchorError, RequestTimeout, jsonOf, messageOf, requestWithin, within } from "./errors";
import { ANCHOR } from "./config";
import { NETWORK } from "../stellar/config";
import type { AnchorToml } from "./toml";

/** smart-account-kit's code for a passkey prompt the person closed (SmartAccountErrorCode). */
const WEBAUTHN_CANCELLED = 4004;
/** smart-account-kit's WebAuthn error codes (4001 to 4004). */
const WEBAUTHN_CODES = new Set([4001, 4002, 4003, 4004]);
/** What the browser's passkey prompt (or @simplewebauthn) raises. */
const PASSKEY_ERRORS = new Set(["NotAllowedError", "AbortError", "SecurityError", "InvalidStateError", "NotSupportedError", "WebAuthnError"]);
/**
 * Longest wait for the kit's signing of the sign-in entry: its own network reads (the wallet's rules and
 * code) come before the passkey prompt and have no timeout, and the prompt itself times out well within this.
 */
export const SIGN_ENTRY_TIMEOUT_MS = 3 * 60_000;

/** Whether a failure came from the passkey prompt itself, not from the kit's network reads before it. */
function passkeyFailed(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, name, cause } = e as { code?: unknown; name?: unknown; cause?: unknown };
  if (typeof code === "number" && WEBAUTHN_CODES.has(code)) return true;
  if (typeof name === "string" && PASSKEY_ERRORS.has(name)) return true;
  return typeof cause === "object" && cause !== null && PASSKEY_ERRORS.has(String((cause as { name?: unknown }).name));
}

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

/**
 * Whether `e` is the anchor's own entry, signed by `signingKey` (the SIGNING_KEY its stellar.toml publishes):
 * address credentials for that G account, and one ed25519 signature by that key over the entry's Soroban
 * authorization preimage (network id, nonce, expiry ledger, invocation), in the shape a Stellar account signs
 * ({ public_key, signature }). SEP-45 has the client verify this before it signs (Codex cash-out R1 #2).
 */
function signedByAnchor(e: xdr.SorobanAuthorizationEntry, signingKey: string): boolean {
  try {
    const c = e.credentials();
    if (c.switch().name !== "sorobanCredentialsAddress") return false;
    const creds = c.address();
    if (Address.fromScAddress(creds.address()).toString() !== signingKey) return false;
    const sig = creds.signature();
    if (sig.switch().name !== "scvVec" || (sig.vec() ?? []).length !== 1) return false;
    const one = scValToNative(sig.vec()![0]!) as { public_key?: unknown; signature?: unknown } | null;
    const key = Keypair.fromPublicKey(signingKey);
    if (!one || !(one.public_key instanceof Uint8Array) || !(one.signature instanceof Uint8Array)) return false;
    if (!Buffer.from(one.public_key).equals(key.rawPublicKey())) return false;
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(NETWORK.passphrase)),
        nonce: creds.nonce(),
        signatureExpirationLedger: creds.signatureExpirationLedger(),
        invocation: e.rootInvocation(),
      }),
    );
    return key.verify(hash(preimage.toXDR()), Buffer.from(one.signature));
  } catch {
    return false;
  }
}

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
  // Exactly the wallet's entry and the anchor's, signed by the key its stellar.toml publishes (Caracal sends no
  // client_domain, so there is no third). A challenge the anchor did not sign could come from anyone.
  const anchors = entries.flatMap((e, i) => (i !== own[0] && signedByAnchor(e, toml.signingKey) ? [i] : []));
  if (entries.length !== 2 || anchors.length !== 1) {
    throw new AnchorError("The anchor's sign-in challenge is not signed by the anchor's published key (SIGNING_KEY in its stellar.toml), so it may not be the anchor's. Nothing was signed.", "sign-in");
  }
  // SEP-45: the client's entry is handed over unsigned. One that already carries a signature is the anchor's malformed challenge.
  if (entries[own[0]!]!.credentials().address().signature().switch().name !== "scvVoid") {
    throw new AnchorError("The anchor's sign-in challenge arrived with the wallet's entry already signed, which a sign-in challenge must not be. Refused as the anchor's. Nothing was signed or sent.", "sign-in");
  }
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
    const native = scValToNative(call.args()[0]!) as unknown;
    if (typeof native !== "object" || native === null) throw new AnchorError("The anchor's sign-in challenge was not in the expected shape. Nothing was signed.", "sign-in");
    const a = native as Record<string, unknown>;
    if (a.account !== wallet || a.home_domain !== ANCHOR.homeDomain || a.web_auth_domain !== ANCHOR.homeDomain || a.web_auth_domain_account !== toml.signingKey) {
      throw new AnchorError("The anchor's sign-in challenge names a different wallet or domain than expected. Nothing was signed.", "sign-in");
    }
  }
  // Every entry authorizes the same call, with the same arguments and nonce.
  const firstArgs = entries[0]!.rootInvocation().toXDR("base64");
  if (entries.some((e) => e.rootInvocation().toXDR("base64") !== firstArgs)) {
    throw new AnchorError("The anchor's sign-in challenge has entries for different calls or nonces. Nothing was signed.", "sign-in");
  }
  return { entries, own: own[0]! };
}

/** Sign in. Returns the anchor's token. Needs one passkey confirmation. */
export async function signInToAnchor(wallet: string, toml: AnchorToml, deps: Sep45Deps): Promise<string> {
  const query = new URLSearchParams({ account: wallet, home_domain: ANCHOR.homeDomain });
  let challenge;
  try {
    challenge = await requestWithin(deps.fetchFn, `${toml.webAuthEndpoint}?${query}`, { cache: "no-store" });
  } catch (e) {
    if (e instanceof RequestTimeout) throw new AnchorError("The test anchor did not answer within 20 seconds when Caracal started the sign-in. Nothing was signed. Try again.", "sign-in");
    throw new AnchorError("Caracal could not reach the test anchor to sign in. Check your connection and try again.", "sign-in");
  }
  if (!challenge.ok) throw new AnchorError(`The test anchor refused to start a sign-in for your wallet (it answered ${challenge.status}). Try again in a minute.`, "sign-in");
  const body = jsonOf(challenge.text);
  const text = typeof body === "object" && body !== null ? (body as Record<string, unknown>).authorization_entries : undefined;
  if (typeof text !== "string") throw new AnchorError("The test anchor's sign-in challenge was not in the expected shape. Nothing was signed.", "sign-in");

  const { entries, own } = checkChallenge(text, wallet, toml);
  let latest: number;
  try {
    latest = await within(deps.latestLedger());
  } catch (e) {
    console.error("anchor sign-in: latest ledger:", messageOf(e));
    throw new AnchorError(
      e instanceof RequestTimeout
        ? "The Stellar network did not answer within 20 seconds when Caracal started the sign-in. Nothing was signed. Try again."
        : "Caracal could not reach the Stellar network to start the sign-in. Nothing was signed. Check your connection and try again.",
      "sign-in",
    );
  }
  const expiration = latest + SIGNATURE_LEDGERS;
  // Rule 0 is the default rule every Caracal wallet is created with; a
  // web_auth_verify call on another contract falls under its default context.
  try {
    entries[own] = await within(deps.signAuthEntry(entries[own]!, { expiration, contextRuleIds: [0] }), SIGN_ENTRY_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof RequestTimeout) {
      throw new AnchorError("Caracal got no answer within 3 minutes while preparing or signing the anchor's sign-in. Nothing was started. Check your connection and try again.", "sign-in");
    }
    if (typeof e === "object" && e !== null && (e as { code?: number }).code === WEBAUTHN_CANCELLED) {
      throw new AnchorError("You cancelled the passkey prompt, so Caracal did not sign in to the anchor. Nothing was started.", "sign-in");
    }
    console.error("anchor sign-in: signing failed:", messageOf(e));
    // Only a failure of the passkey prompt itself is put down to the passkey; the kit reads the network first.
    if (passkeyFailed(e)) throw new AnchorError("Your passkey could not sign the anchor's sign-in. Nothing was started. Try again.", "sign-in");
    throw new AnchorError("Caracal could not prepare the anchor's sign-in for your passkey, usually because the Stellar network could not be read. Nothing was started. Check your connection and try again.", "sign-in");
  }

  let answer;
  try {
    answer = await requestWithin(deps.fetchFn, toml.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization_entries: encodeEntries(entries) }),
    });
  } catch (e) {
    if (e instanceof RequestTimeout) throw new AnchorError("The test anchor did not answer within 20 seconds when Caracal finished the sign-in. Nothing was started. Try again.", "sign-in");
    throw new AnchorError("Caracal could not reach the test anchor to finish signing in. Check your connection and try again.", "sign-in");
  }
  if (!answer.ok) throw new AnchorError(`The test anchor did not accept the signed sign-in (it answered ${answer.status}). Nothing was started. Try again.`, "sign-in");
  const done = jsonOf(answer.text);
  const token = typeof done === "object" && done !== null ? (done as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || token.length === 0) throw new AnchorError("The test anchor accepted the sign-in but sent no token. Try again.", "sign-in");
  return token;
}
