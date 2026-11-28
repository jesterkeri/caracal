// A browser's localStorage, kept in memory, for page tests that stub `window` without one. Every browser that
// supports passkeys has it, and the pay and invoices pages now refuse to send a payment or cancellation whose record
// it will not keep (Codex invoices R4 #2), as they would in a real browser that blocks site data.
export function memoryStorage(kept = new Map<string, string>()) {
  return {
    kept,
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
  };
}
