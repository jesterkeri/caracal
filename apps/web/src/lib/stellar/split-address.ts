// Each user's split contract has a fixed address, derived from their passkey
// wallet, so every page can find it without a database: the wallet deploys it
// (createContractV2 from the wallet's own address) with SPLIT_SALT.

import { Buffer } from "buffer";
import { Address, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import { NETWORK } from "./config";

/** The salt every Caracal split contract is deployed with: sha256("caracal-split-v1"). */
export const SPLIT_SALT: Buffer = hash(Buffer.from("caracal-split-v1"));

/** The address a contract gets when `deployer` deploys it with `salt` (createContractV2 from an address). */
export function contractAddressFrom(deployer: string, salt: Buffer, networkPassphrase: string = NETWORK.passphrase): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** The split contract of the passkey wallet `wallet` (a C address), whether deployed yet or not. */
export function splitAddressFor(wallet: string, networkPassphrase: string = NETWORK.passphrase): string {
  if (!StrKey.isValidContract(wallet)) throw new Error("A split contract belongs to a passkey wallet (a C address)");
  return contractAddressFrom(wallet, SPLIT_SALT, networkPassphrase);
}
