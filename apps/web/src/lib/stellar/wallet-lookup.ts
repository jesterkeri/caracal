// Whether a passkey's wallet exists on chain, asked of the network directly.
//
// smart-account-kit 0.10.0 says "Smart account contract not found on-chain for
// credential X" for ANY failed lookup of the wallet's contract, a network
// failure included. A healthy ledger endpoint does not prove the lookup found
// nothing, so the wallet page looks up that exact contract itself and says "no
// wallet" only when the network answers that it has no such contract.

import { Buffer } from "buffer";
import { Address, Keypair, StrKey, hash, xdr } from "@stellar/stellar-sdk";

/** The kit's shared deployer (no deployerSecret is configured): its seed is public, in smart-account-kit's constants. */
export const SHARED_DEPLOYER = Keypair.fromRawEd25519Seed(hash(Buffer.from("openzeppelin-smart-account-kit"))).publicKey();

/** The kit's wallet address for a passkey credential, derived as smart-account-kit 0.10.0 does (deriveContractAddress). */
export function walletAddressFor(credentialId: string, networkPassphrase: string, deployer: string = SHARED_DEPLOYER): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt: hash(Buffer.from(credentialId, "base64url")),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

const KIT_NOT_FOUND = /^Smart account contract not found on-chain for credential ([A-Za-z0-9_-]+)\./;

/** The credential named in the kit's "not found on-chain" error, or null for any other error. */
export function credentialInKitError(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  return KIT_NOT_FOUND.exec(e.message)?.[1] ?? null;
}

/**
 * absent: the network answered and holds no such contract.
 * archived: the contract exists, but its data expired and must be restored.
 * present: the contract exists and is live (the kit's lookup failed for another reason).
 * unknown: the lookup failed or did not answer in time.
 */
export type WalletStatus = "absent" | "archived" | "present" | "unknown";

/** The part of a stellar-sdk rpc.Server used here. */
export type LedgerReader = {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries: { liveUntilLedgerSeq?: number }[]; latestLedger: number }>;
};

export const LOOKUP_TIMEOUT_MS = 10_000;

/** Looks up the wallet contract's instance entry (within 10 s). */
export async function walletStatus(rpc: LedgerReader | undefined, contractId: string): Promise<WalletStatus> {
  if (!rpc || typeof rpc.getLedgerEntries !== "function") return "unknown";
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  } catch {
    return "unknown";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      rpc.getLedgerEntries(key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer")), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (!answer || !Array.isArray(answer.entries) || typeof answer.latestLedger !== "number") return "unknown";
    if (answer.entries.length === 0) return "absent";
    const live = answer.entries[0].liveUntilLedgerSeq;
    return typeof live === "number" && live < answer.latestLedger ? "archived" : "present";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
