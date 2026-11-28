// The tax estimate route's deadline (Codex tax R4 #2). The page stops waiting after 2 minutes (app/tax/page.tsx),
// so the server gives up first and says so. The deadline, and the caller going away, abort every network read the
// estimate makes (the RPC and the CBN rate list), so no work goes on after it.

/** The longest one estimate may run on the server. */
export const ESTIMATE_DEADLINE_MS = 100_000;

/** A signal that aborts after `ms`, and a way to clear its timer once the work is done. */
export function deadlineSignal(ms: number = ESTIMATE_DEADLINE_MS): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException("The estimate's deadline passed.", "TimeoutError")), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** fetch, aborted when `stop` is (as well as by any signal the caller of fetch gives). */
export function fetchUntil(stop: AbortSignal, base: Fetch = fetch): Fetch {
  return (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, stop]) : stop });
}
