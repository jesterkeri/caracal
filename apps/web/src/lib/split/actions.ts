// What a person can do with their split contract, as functions the page calls.
// Every write checks what the contract would refuse first, so a person is not
// sent to a passkey prompt for something that cannot work, then goes through
// sendSplitCall (the wallet's passkey and Caracal's fee relay).

import { splitAddressFor } from "../stellar/split-address";
import { formatUsdc, splitProblem } from "./amounts";
import { readConfig, readPots, splitStatus, type Pots, type SimulatingRpc, type SplitConfig } from "./chain";
import { deploySplitFunction, moveFunction, setSplitFunction, withdrawFunction, type Pot } from "./calls";
import { sendSplitCall, type BuildTx, type SendOutcome, type WriteKit } from "./send";
import type { LedgerReader } from "../stellar/wallet-lookup";

export type Loaded =
  /**
   * The network returned no split contract at the wallet's split address: none
   * was deployed, or (Codex R6 #2) one whose data expired and that the RPC does
   * not return. Deploying is offered: in the second case the network refuses a
   * deployment at an address that is taken, so nothing is made or sent.
   */
  | { kind: "absent"; split: string }
  /** It exists and was read. */
  | { kind: "present"; split: string; pots: Pots; config: SplitConfig }
  /** It exists but its data expired and must be restored first. */
  | { kind: "archived"; split: string }
  /** What exists could not be read: the network did not answer, or the contract is not this wallet's. */
  | { kind: "error"; split: string; message: string };

export const POT_LABEL: Record<Pot, string> = { Tax: "Tax", Goal: "Goal", Spend: "Spend" };
const potKey = (p: Pot): keyof Pots => (p === "Tax" ? "tax" : p === "Goal" ? "goal" : "spend");
export const potBalance = (pots: Pots, p: Pot): bigint => pots[potKey(p)];

const stopped = (message: string): SendOutcome => ({ kind: "stopped", message });

/** The split contract of `wallet`: whether it exists, and if so its pots and settings, read from the network. */
export async function loadSplit(server: (LedgerReader & SimulatingRpc) | undefined, wallet: string): Promise<Loaded> {
  const split = splitAddressFor(wallet);
  const { status } = await splitStatus(server, wallet);
  if (status === "not-found") return { kind: "absent", split };
  if (status === "archived") return { kind: "archived", split };
  if (status === "unknown" || !server) return { kind: "error", split, message: "Caracal could not reach the Stellar network to look for your split contract. Check your connection and try again." };
  try {
    const [pots, config] = await Promise.all([readPots(server, split), readConfig(server, split)]);
    // Only this wallet can have deployed this address, so a different owner means something is badly wrong.
    if (config.owner !== wallet) return { kind: "error", split, message: "The contract at your split address is not owned by your wallet, so Caracal will not use it." };
    return { kind: "present", split, pots, config };
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
