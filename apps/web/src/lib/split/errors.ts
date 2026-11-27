// The split contract's refusals, in plain English. The network reports them as
// `Error(Contract, #N)`; N is the contract's own error code (see
// contracts/split/README.md).

import { TOKENS } from "../stellar/config";

const SPLIT_ERRORS: Record<number, string> = {
  1: "Tax and goal together cannot be more than 100%.",
  2: "The amount must be more than zero.",
  4: "That pot does not hold enough USDC for this.",
  5: "Choose two different pots.",
  7: "The amount is too large for the contract to add up.",
  13: "You cannot withdraw to the split contract itself.",
};

/**
 * Text for a failure the network reported. The same code number means different things in different
 * contracts (the USDC token has its own), so a code is read as the split's only when the diagnostic does not
 * name a different contract. The error passes up through every caller, so the oldest event line that names
 * a contract is the one that raised it. A bare "HostError: Error(Contract, #N)" names none: the call was to
 * the split itself, so it is read as the split's. When `split` is not given, a named contract cannot be
 * compared, so the code is not attributed.
 */
export function splitErrorText(diagnostic: string, split?: string): string {
  const found = diagnostic
    .split("\n")
    .map((line) => ({ m: /Error\(Contract,\s*#(\d+)\)/.exec(line), from: /contract:(C[A-Z2-7]{55})/.exec(line)?.[1] }))
    .filter((x): x is { m: RegExpExecArray; from: string | undefined } => x.m !== null);
  const named = found.filter((x) => x.from !== undefined);
  const origin = named.length > 0 ? named[named.length - 1]! : found[0];
  if (!origin) return diagnostic;
  const code = Number(origin.m[1]);
  if (origin.from !== undefined && origin.from !== split) {
    if (origin.from === TOKENS.usdc) return `The USDC contract refused this (its error code ${code}), not your split contract.`;
    if (split !== undefined) return `A contract other than your split refused this (its error code ${code}).`;
    return `A contract refused this (its error code ${code}), and Caracal could not tell which one.`;
  }
  if (SPLIT_ERRORS[code]) return SPLIT_ERRORS[code];
  // The wallet's own codes start at 3000: not the split contract's to own.
  if (code < 100) return `The split contract refused this (its error code ${code}).`;
  return diagnostic;
}
