// Adversary r3k suspicion: the browser Supabase client's request deadline must
// work without AbortSignal.timeout/any, and keep the caller's own signal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPABASE_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../src/lib/supabase/client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch that never answers, but rejects when its signal aborts (like the real one). */
const hangingFetch = () =>
  vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
  );

describe("fetchWithTimeout", () => {
  it("a request that never answers is aborted at the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = fetchWithTimeout("https://x.supabase.co/auth/v1/logout");
    const outcome = p.then(() => "resolved", (e: { name?: string }) => e.name);
    await vi.advanceTimersByTimeAsync(SUPABASE_REQUEST_TIMEOUT_MS);
    expect(await outcome).toBe("TimeoutError");
  });

  it("the caller's own signal still cancels it, before the deadline", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const caller = new AbortController();
    const p = fetchWithTimeout("https://x.supabase.co/rest/v1/x", { signal: caller.signal });
    caller.abort(new DOMException("caller gave up", "AbortError"));
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("works where AbortSignal.timeout and AbortSignal.any do not exist", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const { timeout, any } = AbortSignal as unknown as { timeout?: unknown; any?: unknown };
    Object.assign(AbortSignal, { timeout: undefined, any: undefined });
    try {
      const outcome = fetchWithTimeout("https://x.supabase.co/a", { signal: new AbortController().signal }).then(() => "resolved", (e: { name?: string }) => e.name);
      await vi.advanceTimersByTimeAsync(SUPABASE_REQUEST_TIMEOUT_MS);
      expect(await outcome).toBe("TimeoutError");
    } finally {
      Object.assign(AbortSignal, { timeout, any });
    }
  });

  it("an answer in time is passed through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    expect(await (await fetchWithTimeout("https://x.supabase.co/a")).text()).toBe("ok");
  });
});
