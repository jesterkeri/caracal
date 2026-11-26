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
  const deadline = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init?.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, deadline]) : (init?.signal ?? deadline);
  return fetch(input, { ...init, signal });
};

export function supabaseBrowser() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient(url, anonKey, { global: { fetch: fetchWithTimeout } });
}
