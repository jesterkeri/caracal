// Shared fixtures for the relay policy tests, shaped like real testnet data:
// - WALLET: a passkey wallet deployed 2026-11-25 (tx 77975e3e...), running the
//   OpenZeppelin account wasm.
// - SPLIT_ID: the split contract deployed 2026-11-25 (tx 9db1ab3c...). Its live
//   instance storage keys are Token, Owner, TaxBps, GoalBps, Pot(..). On chain its
//   owner is the CLI deployer; here it is owned by WALLET, as an app-deployed split
//   would be.
// - Wallet constructor args copy the shape of deploy tx 1559440b...:
//   (Vec[External(verifier, key)], Map{}).
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { InstanceLookup, WasmLookup } from "../src/lib/relay/policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";

export const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
export const SPLIT_ID = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
export const OLD_SPLIT_ID = "CB2WIGKDHY542ZLLQQPK7JB2ZN2NL25JLQT7YADWEWMEAHDXFWCFLGQ2";
export const OLD_SPLIT_HASH = "24d6dafcf0d0204ce0437071191562003bc4fea039fc92ee5746c10e30ccaf13";
/** smart-account-kit's shared deployer, from deploy tx 1559440b... */
export const SHARED_DEPLOYER = "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N";
export const CLI_OWNER = "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX";

export const addr = (a: string) => nativeToScVal(Address.fromString(a));
const key = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);

export function splitStorage(owner = WALLET, token: string = TOKENS.usdc): xdr.ScMapEntry[] {
  return [
    new xdr.ScMapEntry({ key: key("Owner"), val: addr(owner) }),
    new xdr.ScMapEntry({ key: key("Token"), val: addr(token) }),
    new xdr.ScMapEntry({ key: key("TaxBps"), val: xdr.ScVal.scvU32(1000) }),
    new xdr.ScMapEntry({ key: key("GoalBps"), val: xdr.ScVal.scvU32(1500) }),
  ];
}

export const wasmOf: Record<string, string> = {
  [WALLET]: SMART_ACCOUNT.accountWasmHash,
  [SPLIT_ID]: SPLIT.wasmHash,
  [OLD_SPLIT_ID]: OLD_SPLIT_HASH,
};
export const lookupWasm: WasmLookup = async (id) => wasmOf[id] ?? null;
export const lookupInstance: InstanceLookup = async (id) => (id === SPLIT_ID ? splitStorage() : null);

/** deposit(from, amount, invoice_ref) paid by WALLET. */
export const depositArgs = (from = WALLET) => [addr(from), nativeToScVal(BigInt(500000), { type: "i128" }), xdr.ScVal.scvBytes(Buffer.from("INV-DAY2-1"))];
/** transfer(from, to, amount) from WALLET. */
export const transferArgs = (from = WALLET, to = SPLIT_ID) => [addr(from), addr(to), nativeToScVal(BigInt(500000), { type: "i128" })];

/** Wallet constructor: one WebAuthn passkey signer, no policies. */
export function walletCtorArgs(verifier: string = SMART_ACCOUNT.webauthnVerifier, extraPolicies = false): xdr.ScVal[] {
  const signer = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), addr(verifier), xdr.ScVal.scvBytes(Buffer.alloc(65, 4))]);
  const policies = xdr.ScVal.scvMap(
    extraPolicies ? [new xdr.ScMapEntry({ key: addr(SPLIT_ID), val: xdr.ScVal.scvVoid() })] : [],
  );
  return [xdr.ScVal.scvVec([signer]), policies];
}
/** Split constructor: (owner, token, tax_bps, goal_bps). */
export const splitCtorArgs = (owner = WALLET, token: string = TOKENS.usdc) => [addr(owner), addr(token), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)];

/** Default realistic args for a call, by function name. */
export function argsFor(fn: string): xdr.ScVal[] {
  if (fn === "deposit") return depositArgs();
  if (fn === "transfer") return transferArgs();
  return [];
}
/** Default realistic constructor args for a deploy, by wasm hash. */
export function ctorFor(hash: string): xdr.ScVal[] {
  if (hash === SMART_ACCOUNT.accountWasmHash) return walletCtorArgs();
  if (hash === SPLIT.wasmHash) return splitCtorArgs();
  return [];
}
