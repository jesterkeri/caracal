"use client";
import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

export { SUPABASE_REQUEST_TIMEOUT_MS, fetchWithDeadline, fetchWithTimeout } from "./deadline";
import { fetchWithTimeout } from "./deadline";

export function supabaseBrowser() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient(url, anonKey, { global: { fetch: fetchWithTimeout } });
}
