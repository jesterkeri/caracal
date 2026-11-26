// The deadline for every Supabase request, browser and server. No "use client"
// here, so route handlers can use it too.

/** Longest wait for one Supabase request from the browser. */
export const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;

/** Statuses whose response can have no body (the Response constructor refuses one). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * fetch with a deadline that covers the whole answer, body included. supabase-js
 * has none, and it holds its session lock while a request is in flight, so one
 * hung request (say, the sign-out revoke) would otherwise block every later
 * auth call, including the local sign-out. A server that sends its headers and
 * then stalls is hung too, so the body is read here, under the same deadline,
 * and handed on already complete. Supabase's auth and data answers are small.
 */
export function fetchWithDeadline(ms: number): typeof fetch {
  return async (input, init) => {
    // Built by hand (not AbortSignal.timeout/any) so it works on every browser
    // and keeps both the deadline and the caller's own signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Supabase did not answer in time", "TimeoutError")), ms);
    const outer = init?.signal;
    const forward = () => controller.abort(outer?.reason);
    if (outer?.aborted) forward();
    else outer?.addEventListener("abort", forward, { once: true });
    // Settles as soon as the signal aborts, even if a body read does not react to it.
    const aborted = new Promise<never>((_, reject) => {
      const stop = () => reject(controller.signal.reason);
      if (controller.signal.aborted) stop();
      else controller.signal.addEventListener("abort", stop, { once: true });
    });
    aborted.catch(() => {});
    try {
      const res = await Promise.race([fetch(input, { ...init, signal: controller.signal }), aborted]);
      const body = NULL_BODY.has(res.status) ? null : await Promise.race([res.arrayBuffer(), aborted]);
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    }
  };
}

export const fetchWithTimeout: typeof fetch = fetchWithDeadline(SUPABASE_REQUEST_TIMEOUT_MS);
