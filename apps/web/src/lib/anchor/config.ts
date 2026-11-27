// The SDF test anchor Caracal cashes out through, and the facts pinned about it.
// Sources: docs/research/verify-2026-11-25.md section 7 and the live spike in
// docs/research/anchor-spike-2026-11-27.md. Nothing here is secret.

export const ANCHOR = {
  homeDomain: "testanchor.stellar.org",
  tomlUrl: "https://testanchor.stellar.org/.well-known/stellar.toml",
  /** The SEP-45 web auth contract the anchor's toml lists. Pinned: a wallet never signs for any other. */
  webAuthContract: "CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX",
} as const;

/** The USDC the wallet holds and the anchor lists (Circle testnet USDC). */
export const CASHOUT_ASSET = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  /** SEP-38 style asset id the anchor uses in its answers. */
  id: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  decimals: 7,
} as const;

/** The anchor's interactive form is only opened on a stellar.org https address. */
export const INTERACTIVE_HOST_SUFFIX = ".stellar.org";

/** Plain-English notes shown on the cash-out page. No em dashes. */
export const SIMULATION_NOTE =
  "This is the Stellar test anchor. Its withdrawal is simulated: your test USDC leaves your wallet and the anchor marks the withdrawal complete, but no naira reaches a bank. A live naira payout needs a licensed anchor partner.";

export const STAMP_DUTY_NOTE = {
  text: "Stamp duty may apply to a cash-out. The rule puts the duty at 1.5% of the amount, paid by the party receiving the tokens, so on a cash-out that is usually the buyer, not you. Caracal shows this note only. It deducts nothing and does not collect any duty.",
  source:
    "Nigeria Tax Act (NTA), Ninth Schedule item 33, as reported by PwC and KPMG. These are secondary sources: the gazetted text could not be read, so check the rule with a tax adviser (docs/research/verify-2026-11-25.md section 9).",
} as const;
