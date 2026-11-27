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
  for (const line of text.split("\n")) {
    const m = /Error\(Contract,\s*#(\d+)\)/.exec(line);
    if (!m) continue;
    const from = /contract:(C[A-Z2-7]{55})/.exec(line)?.[1];
    if (from === usdc) return m[1] === "10" ? "The wallet does not hold enough USDC to pay this invoice." : null;
    if (from !== undefined && from !== split) return null;
    return SPLIT_ERRORS[Number(m[1])] ?? null;
  }
  return null;
}
