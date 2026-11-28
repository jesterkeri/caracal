// A stand-in for the test anchor's signing key in tests. The real anchor signs its SEP-45 entry with the
// SIGNING_KEY its stellar.toml publishes (a real challenge, signature included, is kept in
// fixtures/anchor/sep45-challenge.json); tests that build their own challenges cannot sign with that key,
// so they sign with this one and serve the toml with this key in its place (Codex cash-out R1 #2: the
// page now verifies the anchor's signature before the passkey is asked).
import { Keypair, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { NETWORK } from "../src/lib/stellar/config";

export const REAL_SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR";
const anchorKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 45));
export const TEST_SIGNING_KEY = anchorKey.publicKey();

/** The entry signed as the anchor signs its own: a Stellar account signature over the authorization preimage. */
export function signAsAnchor(e: xdr.SorobanAuthorizationEntry, key: Keypair = anchorKey): xdr.SorobanAuthorizationEntry {
  const creds = e.credentials().address();
  creds.signatureExpirationLedger(5_965_482);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({ networkId: hash(Buffer.from(NETWORK.passphrase)), nonce: creds.nonce(), signatureExpirationLedger: creds.signatureExpirationLedger(), invocation: e.rootInvocation() }),
  );
  const signature = key.sign(hash(preimage.toXDR()));
  creds.signature(xdr.ScVal.scvVec([nativeToScVal({ public_key: key.rawPublicKey(), signature }, { type: { public_key: ["symbol", null], signature: ["symbol", null] } })]));
  return e;
}

/** The real stellar.toml with the test key as its SIGNING_KEY. */
export const withTestKey = (toml: string) => toml.replace(REAL_SIGNING_KEY, TEST_SIGNING_KEY);
