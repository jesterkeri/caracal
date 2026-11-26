import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { fetchWithTimeout } from "./deadline";
import { supabaseEnv } from "./env";

/** Supabase client for route handlers and server components, backed by the request cookies. */
export async function supabaseServer() {
  const { url, anonKey } = supabaseEnv();
  const store = await cookies();
  return createServerClient(url, anonKey, {
    // The same deadline as the browser: the sign-in code exchange cannot hang the callback.
    global: { fetch: fetchWithTimeout },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) store.set(name, value, options);
      },
    },
  });
}
