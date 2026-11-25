// What Caracal pays fees for. Everything not described here is refused.
//
// Two ideas hold it together:
// 1. Every address that must authorise a sponsored call is a Caracal passkey
//    wallet (a C address running the OpenZeppelin account wasm), or the wallet
//    kit's shared deployer while it deploys a wallet. A classic (G) address is
//    never a payer, an owner or a signer, so the relayer's own account can
//    never authorise anything implicitly as the transaction source.
// 2. Every contract whose code runs is Caracal's: the split contract over
//    USDC, a passkey wallet using the official WebAuthn verifier, and the USDC
//    asset contract. A split contract over some other token, or a wallet with
//    some other verifier, would run outside code on Caracal's fees.
//
// Read-only functions are not listed: they are simulated, never submitted.

import { SMART_ACCOUNT, SPLIT, TOKENS } from "../stellar/config";
import { scAddress, storageGet, type ArgsRule, type Policy, type StorageRule } from "./policy";

const MAX_WALLET_SIGNERS = 4;

/** `args[i]` must be a Caracal passkey wallet. */
const walletArg =
  (i: number, what: string): ArgsRule =>
  async (args, ctx) => {
    const a = scAddress(args[i]);
    if (a === null) return `${what} must be an address`;
    return (await ctx.isWallet(a)) ? null : `${what} must be a Caracal passkey wallet`;
  };

/** Split constructor: (owner, token, tax_bps, goal_bps). */
const splitConstructor: ArgsRule = async (args, ctx) => {
  if (args.length !== 4) return "Split contract constructor must be (owner, token, tax_bps, goal_bps)";
  if (scAddress(args[1]) !== TOKENS.usdc) return "A split contract must hold USDC";
  return walletArg(0, "The split contract owner")(args, ctx);
};

/** Wallet constructor: (signers, policies). Only WebAuthn passkey signers, no policies. */
const walletConstructor: ArgsRule = async (args) => {
  if (args.length !== 2) return "Wallet constructor must be (signers, policies)";
  const [signers, policies] = args;
  if (signers?.switch().name !== "scvVec") return "Wallet signers must be a list";
  const list = signers.vec() ?? [];
  if (list.length < 1 || list.length > MAX_WALLET_SIGNERS) return "A wallet needs 1 to 4 passkey signers";
  for (const s of list) {
    // Signer::External(verifier, public key) is encoded as Vec[Symbol("External"), Address, Bytes].
    const parts = s.switch().name === "scvVec" ? (s.vec() ?? []) : [];
    const kind = parts[0]?.switch().name === "scvSymbol" ? parts[0].sym().toString() : null;
    if (parts.length !== 3 || kind !== "External") return "Wallet signers must be passkeys";
    if (scAddress(parts[1]) !== SMART_ACCOUNT.webauthnVerifier) return "Wallet signers must use the WebAuthn verifier";
    if (parts[2]?.switch().name !== "scvBytes") return "A passkey signer needs a public key";
  }
  if (policies?.switch().name !== "scvMap" || (policies.map() ?? []).length !== 0) {
    return "Sponsored wallets are created without policies";
  }
  return null;
};

/** A deployed split contract must hold USDC and be owned by a passkey wallet. */
const splitStorage: StorageRule = async (storage, ctx) => {
  if (scAddress(storageGet(storage, "Token")) !== TOKENS.usdc) return "This split contract does not hold USDC";
  const owner = scAddress(storageGet(storage, "Owner"));
  if (owner === null || !(await ctx.isWallet(owner))) return "This split contract is not owned by a Caracal passkey wallet";
  return null;
};

export const CARACAL_POLICY: Policy = {
  wasmFunctions: new Map([
    // A passkey wallet's own entry point for calls it makes; the inner call is checked too.
    [SMART_ACCOUNT.accountWasmHash, new Set(["execute"])],
    [
      SPLIT.wasmHash,
      new Set(["deposit", "create_invoice", "cancel_invoice", "withdraw", "move_between", "set_split", "reconcile"]),
    ],
  ]),
  deployable: new Map([
    [SMART_ACCOUNT.accountWasmHash, walletConstructor],
    [SPLIT.wasmHash, splitConstructor],
  ]),
  deployerAuth: new Map([[SMART_ACCOUNT.sharedDeployer, new Set([SMART_ACCOUNT.accountWasmHash])]]),
  executors: new Set([SMART_ACCOUNT.accountWasmHash]),
  sacFunctions: new Map([[TOKENS.usdc, new Set(["transfer"])]]),
  callRules: new Map<string, ArgsRule>([
    // transfer(from, to, amount): the payer is a passkey wallet, never a classic account.
    [`${TOKENS.usdc}:transfer`, walletArg(0, "The USDC sender")],
    // deposit(from, amount, invoice_ref): same for the client paying an invoice.
    [`${SPLIT.wasmHash}:deposit`, walletArg(0, "The payer")],
  ]),
  storageRules: new Map([[SPLIT.wasmHash, splitStorage]]),
};
