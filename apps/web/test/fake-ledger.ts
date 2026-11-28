// Fixture (Codex R7 #1): a wallet creation now reads the network's latest
// ledger before anything is sent (its close ledger is recorded first and sent
// to the relay). A fake kit with no way to read a ledger would make every
// creation stop with "could not read the Stellar network", so it gets an RPC
// whose latest ledger follows the (possibly fake) clock: one ledger every 5 s,
// as on testnet. A fake that already reads ledgers is left as it is.

/** The ledger a clock-driven fake network is at now. */
export const ledgerNow = () => 1_000_000 + Math.floor(Date.now() / 5000);

export function withLedger<T>(kit: T): T {
  const k = kit as unknown as { rpc?: Record<string, unknown> } | null | undefined;
  if (!k || typeof k !== "object") return kit;
  if (k.rpc && typeof k.rpc.getLatestLedger === "function") return kit;
  k.rpc = Object.assign(k.rpc ?? {}, { getLatestLedger: async () => ({ sequence: ledgerNow() }) });
  return kit;
}
