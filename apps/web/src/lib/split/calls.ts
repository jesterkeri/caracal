// The exact host functions Caracal sends for a split contract. Pure: they build
// XDR and touch no network, so tests can read back what would be signed.

import { Buffer } from "buffer";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SPLIT, TOKENS } from "../stellar/config";
import { SPLIT_SALT } from "../stellar/split-address";

export type Pot = "Tax" | "Goal" | "Spend";
export const POTS: readonly Pot[] = ["Tax", "Goal", "Spend"];

const address = (a: string) => xdr.ScVal.scvAddress(Address.fromString(a).toScAddress());
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u32 = (n: number) => xdr.ScVal.scvU32(n);
/** A unit variant of the contract's `Pot` enum is a one-element vector holding its name. */
export const potScVal = (pot: Pot) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(pot)]);

/** The wallet deploys its own split: createContractV2 from the wallet's address, salt SPLIT_SALT, constructor (owner, token, tax_bps, goal_bps). */
export function deploySplitFunction(wallet: string, taxBps: number, goalBps: number): xdr.HostFunction {
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(wallet).toScAddress(), salt: Buffer.from(SPLIT_SALT) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT.wasmHash, "hex")),
    constructorArgs: [address(wallet), address(TOKENS.usdc), u32(taxBps), u32(goalBps)],
  });
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(args);
}

/** A call to a function of a split contract. */
export function splitCall(split: string, fn: string, args: xdr.ScVal[]): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(split).toScAddress(), functionName: fn, args }),
  );
}

/** withdraw(pot, to, amount): owner only. */
export const withdrawFunction = (split: string, pot: Pot, to: string, amount: bigint) => splitCall(split, "withdraw", [potScVal(pot), address(to), i128(amount)]);
/** move_between(from_pot, to_pot, amount): owner only. */
export const moveFunction = (split: string, from: Pot, to: Pot, amount: bigint) => splitCall(split, "move_between", [potScVal(from), potScVal(to), i128(amount)]);
/** set_split(tax_bps, goal_bps): owner only; applies to future deposits. */
export const setSplitFunction = (split: string, taxBps: number, goalBps: number) => splitCall(split, "set_split", [u32(taxBps), u32(goalBps)]);
