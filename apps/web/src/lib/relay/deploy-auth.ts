// Shortens how long a wallet deployment can still land.
//
// smart-account-kit 0.10.0 signs the shared deployer's authorisation for a
// wallet deployment valid for 720 ledgers (about an hour), so a creation whose
// answer was lost could in principle still land an hour later. The wallet page
// lets a person start a new wallet a few minutes after an unknown outcome, so
// the relay re-signs that authorisation to expire a few ledgers after it is
// forwarded. The shared deployer is a sign-only identity whose seed is public
// in the kit's own constants: re-signing needs no secret, and changes nothing
// but the expiry (same nonce, same deployment, same invocation).

import { authorizeEntry, Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

/** The kit's shared deployer (smart-account-kit DEFAULT_DEPLOYER_SEED). */
const SHARED_DEPLOYER = Keypair.fromRawEd25519Seed(hash(Buffer.from("openzeppelin-smart-account-kit")));

/**
 * Ledgers a forwarded wallet deployment stays valid: about a minute at
 * testnet's 5 to 6 s per ledger, more than the upstream relayer needs.
 */
export const DEPLOY_AUTH_LEDGERS = 12;

/**
 * The body with each of the shared deployer's authorisations re-signed to
 * expire at `expirationLedger`. Throws if any entry is not the shared
 * deployer's address credential (the policy allows no other on this path).
 */
export async function withShortDeployAuth(
  body: { func: string; auth: string[] },
  expirationLedger: number,
  networkPassphrase: string,
): Promise<{ func: string; auth: string[] }> {
  const auth = await Promise.all(
    body.auth.map(async (a) => {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(a, "base64");
      const cr = entry.credentials();
      // Both address arms the policy accepts. stellar-sdk's authorizeEntry keeps the arm and signs the
      // payload that arm needs (ADDRESS_V2 binds the address into it).
      const arm = cr.switch().name;
      if (arm !== "sorobanCredentialsAddress" && arm !== "sorobanCredentialsAddressV2") throw new Error("only the shared deployer's address authorisation is re-signed");
      const addr = (arm === "sorobanCredentialsAddressV2" ? cr.addressV2() : cr.address()).address();
      if (addr.switch().name !== "scAddressTypeAccount" || !addr.accountId().ed25519().equals(SHARED_DEPLOYER.rawPublicKey())) {
        throw new Error("only the shared deployer's address authorisation is re-signed");
      }
      const signed = await authorizeEntry(entry, SHARED_DEPLOYER, expirationLedger, networkPassphrase);
      return signed.toXDR("base64");
    }),
  );
  return { func: body.func, auth };
}
