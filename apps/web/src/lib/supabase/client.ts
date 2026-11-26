"use client";
import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

/** Longest wait for one Supabase request from the browser. */
export const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * fetch with a deadline. supabase-js has none, and it holds its session lock
 * while a request is in flight, so one hung request (say, the sign-out revoke)
 * would otherwise block every later auth call, including the local sign-out.
 */
export const fetchWithTimeout: typeof fetch = (input, init) => {
  // Built by hand (not AbortSignal.timeout/any) so it works on every browser
  // and keeps both the deadline and the caller's own signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Supabase did not answer in time", "TimeoutError")), SUPABASE_REQUEST_TIMEOUT_MS);
  const outer = init?.signal;
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward, { once: true });
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  });
};

export function supabaseBrowser() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient(url, anonKey, { global: { fetch: fetchWithTimeout } });
}
