import { SMART_ACCOUNT, SPLIT, TOKENS } from "../stellar/config";
import type { Policy } from "./policy";

// What Caracal pays fees for. Read-only functions are not listed: they are
// simulated, never submitted.
export const CARACAL_POLICY: Policy = {
  wasmFunctions: new Map([
    // A passkey wallet's own entry point for calls it makes; the inner call is checked too.
    [SMART_ACCOUNT.accountWasmHash, new Set(["execute"])],
    [
      SPLIT.wasmHash,
      new Set([
        "deposit",
        "create_invoice",
        "cancel_invoice",
        "withdraw",
        "move_between",
        "set_split",
        "reconcile",
      ]),
    ],
  ]),
  deployable: new Set([SMART_ACCOUNT.accountWasmHash, SPLIT.wasmHash]),
  executors: new Set([SMART_ACCOUNT.accountWasmHash]),
  sacFunctions: new Map([[TOKENS.usdc, new Set(["transfer"])]]),
};
