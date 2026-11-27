// What the split contract's errors mean to a person (contracts/split/README.md).

import { TOKENS } from "../stellar/config";

const SPLIT_ERRORS: Record<number, string> = {
  1: "The split percentages are too high.",
  2: "The amount is not valid.",
  3: "The invoice id is not valid.",
  4: "There is not enough money in that pot.",
  5: "Those two pots are the same.",
  6: "This invoice has already been paid.",
  7: "The amount is too large.",
  8: "This wallet cannot pay this invoice.",
  9: "An invoice with this id already exists.",
  10: "This invoice does not exist on chain.",
  11: "The amount does not match the invoice. Reload the page and try again.",
  12: "This invoice was cancelled by the freelancer.",
  13: "That recipient is not allowed.",
};

/**
 * The plain-English meaning of the contract error in a simulation's text
 * (`Error(Contract, #6)`). The same number means different things in different
 * contracts, so an error is read as the split's only when the text says the
 * split raised it (or does not say which contract); the USDC contract's
 * "insufficient balance" (#10) is named as that.
 */
export function splitErrorText(text: string, split: string, usdc: string = TOKENS.usdc): string | null {
  const found = text
    .split("\n")
    .map((line) => ({ m: /Error\(Contract,\s*#(\d+)\)/.exec(line), from: /contract:(C[A-Z2-7]{55})/.exec(line)?.[1] }))
    .filter((x): x is { m: RegExpExecArray; from: string | undefined } => x.m !== null);
  // The event log is newest first, and a contract error passes up through every caller: the oldest line that
  // names a contract is the one that raised it. The bare "HostError: Error(Contract, #N)" summary names none,
  // so it is used only when no line says which contract raised the error.
  const named = found.filter((x) => x.from !== undefined);
  const origin = named.length > 0 ? named[named.length - 1]! : found[0];
  if (!origin) return null;
  if (origin.from === usdc) return origin.m[1] === "10" ? "The wallet does not hold enough USDC to pay this invoice." : null;
  if (origin.from !== undefined && origin.from !== split) return null;
  return SPLIT_ERRORS[Number(origin.m[1])] ?? null;
}
