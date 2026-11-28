// What a person can do with their split contract, as functions the page calls.
// Every write checks what the contract would refuse first, so a person is not
// sent to a passkey prompt for something that cannot work, then goes through
// sendSplitCall (the wallet's passkey and Caracal's fee relay).

import { SPLIT, TOKENS } from "../stellar/config";
import { splitAddressFor } from "../stellar/split-address";
import { formatUsdc, splitProblem } from "./amounts";
import { readConfig, readPotsAt, splitStatus, type Pots, type SimulatingRpc, type SplitConfig } from "./chain";
import { deploySplitFunction, moveFunction, setSplitFunction, withdrawFunction, type Pot } from "./calls";
import { sendSplitCall, type BuildTx, type SendOutcome, type WriteKit } from "./send";
import { readInstanceCode, type EntryReader } from "./verify";
import type { LedgerReader } from "../stellar/wallet-lookup";

export type Loaded =
  /**
   * The network returned no split contract at the wallet's split address: none
   * was deployed, or (Codex R6 #2) one whose data expired and that the RPC does
   * not return. Deploying is offered: in the second case the network refuses a
   * deployment at an address that is taken, so nothing is made or sent.
   */
  | { kind: "absent"; split: string; ledger: number | null }
  /** It exists and was read. `ledger`: the ledger its pots were read at (null when the RPC did not say). */
  | { kind: "present"; split: string; pots: Pots; config: SplitConfig; ledger: number | null }
  /** It exists but its data expired and must be restored first. */
  | { kind: "archived"; split: string; ledger: number | null }
  /** What exists could not be read: the network did not answer, or the contract is not this wallet's. */
  | { kind: "error"; split: string; message: string };

export const POT_LABEL: Record<Pot, string> = { Tax: "Tax", Goal: "Goal", Spend: "Spend" };
const potKey = (p: Pot): keyof Pots => (p === "Tax" ? "tax" : p === "Goal" ? "goal" : "spend");
export const potBalance = (pots: Pots, p: Pot): bigint => pots[potKey(p)];

const stopped = (message: string): SendOutcome => ({ kind: "stopped", message });

/** The split contract of `wallet`: whether it exists, and if so its pots and settings, read from the network. */
export async function loadSplit(server: (LedgerReader & SimulatingRpc) | undefined, wallet: string): Promise<Loaded> {
  const split = splitAddressFor(wallet);
  // The ledger the lookup was answered at: what is shown is as of it (a write's hold needs a read past its closeBy).
  let seen: number | null = null;
  const watched =
    server && typeof server.getLedgerEntries === "function"
      ? ({
          // Only the lookup uses it; the reads below go to the server itself.
          getLedgerEntries: async (...keys: Parameters<LedgerReader["getLedgerEntries"]>) => {
            const r = await server.getLedgerEntries(...keys);
            const at = r?.latestLedger;
            if (typeof at === "number" && Number.isSafeInteger(at) && at > 0) seen = at;
            return r;
          },
        } as LedgerReader)
      : server;
  const { status } = await splitStatus(watched, wallet);
  if (status === "not-found") return { kind: "absent", split, ledger: seen };
  if (status === "archived") return { kind: "archived", split, ledger: seen };
  if (status === "unknown" || !server) return { kind: "error", split, message: "Caracal could not reach the Stellar network to look for your split contract. Check your connection and try again." };
  // Not Caracal's split code, or code that could not be checked: show no balance and offer no action.
  const code = await readInstanceCode(server as unknown as EntryReader, split);
  // The lookup above found the entry, so an answer with none now is a lagging or inconsistent node, not proof of
  // other code (adversary s11): it could not be checked.
  if (code.kind === "unchecked" || code.kind === "absent") return { kind: "error", split, message: "Caracal could not check which code your split contract runs, so it will not show or use it yet. Check your connection and try again." };
  if (code.kind !== "wasm" || code.hash !== SPLIT.wasmHash) return { kind: "error", split, message: "The contract at your split address does not run Caracal's split code, so Caracal will not show its balances or use it." };
  try {
    const [{ pots, ledger }, config] = await Promise.all([readPotsAt(server, split), readConfig(server, split)]);
    // Only this wallet can have deployed this address, so a different owner means something is badly wrong.
    if (config.owner !== wallet) return { kind: "error", split, message: "The contract at your split address is not owned by your wallet, so Caracal will not use it." };
    // A split over another token would have its balances shown as USDC.
    if (config.token !== TOKENS.usdc) return { kind: "error", split, message: "Your split contract is set up for a token other than USDC, so Caracal will not show its balances as USDC or use it." };
    return { kind: "present", split, pots, config, ledger };
  } catch (e) {
    return { kind: "error", split, message: `Your split contract exists, but its balances could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Deploys the wallet's own split contract with the chosen tax and goal shares. */
export function deploySplit(kit: WriteKit, wallet: string, taxBps: number, goalBps: number, build?: BuildTx): Promise<SendOutcome> {
  const bad = splitProblem(taxBps, goalBps);
  if (bad) return Promise.resolve(stopped(bad));
  return sendSplitCall(kit, deploySplitFunction(wallet, taxBps, goalBps), "deploy", splitAddressFor(wallet), build);
}

/** Withdraws from a pot to the owner's own wallet. */
export function withdrawToWallet(kit: WriteKit, wallet: string, pots: Pots, pot: Pot, amount: bigint, build?: BuildTx): Promise<SendOutcome> {
  if (amount <= BigInt(0)) return Promise.resolve(stopped("The amount must be more than zero."));
  if (amount > potBalance(pots, pot)) return Promise.resolve(stopped(`The ${POT_LABEL[pot]} pot holds ${formatUsdc(potBalance(pots, pot))} USDC, which is less than that.`));
  const split = splitAddressFor(wallet);
  return sendSplitCall(kit, withdrawFunction(split, pot, wallet, amount), "withdraw", split, build);
}

/** Moves USDC between two pots inside the contract. */
export function moveBetweenPots(kit: WriteKit, wallet: string, pots: Pots, from: Pot, to: Pot, amount: bigint, build?: BuildTx): Promise<SendOutcome> {
  if (from === to) return Promise.resolve(stopped("Choose two different pots."));
  if (amount <= BigInt(0)) return Promise.resolve(stopped("The amount must be more than zero."));
  if (amount > potBalance(pots, from)) return Promise.resolve(stopped(`The ${POT_LABEL[from]} pot holds ${formatUsdc(potBalance(pots, from))} USDC, which is less than that.`));
  const split = splitAddressFor(wallet);
  return sendSplitCall(kit, moveFunction(split, from, to, amount), "move_between", split, build);
}

/** Changes the split for future payments. Money already in the pots stays where it is. */
export function changeSplit(kit: WriteKit, wallet: string, taxBps: number, goalBps: number, build?: BuildTx): Promise<SendOutcome> {
  const bad = splitProblem(taxBps, goalBps);
  if (bad) return Promise.resolve(stopped(bad));
  const split = splitAddressFor(wallet);
  return sendSplitCall(kit, setSplitFunction(split, taxBps, goalBps), "set_split", split, build);
}
