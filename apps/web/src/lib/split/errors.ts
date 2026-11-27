// The split contract's refusals, in plain English. The network reports them as
// `Error(Contract, #N)`; N is the contract's own error code (see
// contracts/split/README.md).

const SPLIT_ERRORS: Record<number, string> = {
  1: "Tax and goal together cannot be more than 100%.",
  2: "The amount must be more than zero.",
  4: "That pot does not hold enough USDC for this.",
  5: "Choose two different pots.",
  7: "The amount is too large for the contract to add up.",
  13: "You cannot withdraw to the split contract itself.",
};

/** Text for a failure the network reported: a split contract code in plain English, anything else as it was said. */
export function splitErrorText(diagnostic: string): string {
  const m = /Error\(Contract,\s*#(\d+)\)/.exec(diagnostic);
  if (m) {
    const code = Number(m[1]);
    if (SPLIT_ERRORS[code]) return SPLIT_ERRORS[code];
    // The wallet's own codes start at 3000: not the split contract's to own.
    if (code < 100) return `The split contract refused this (its error code ${code}).`;
  }
  return diagnostic;
}
