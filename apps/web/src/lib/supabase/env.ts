// Public Supabase settings. The anon key is designed to be shipped to the
// browser; row-level security protects the data. The service role key is never
// imported in app code that reaches the browser.
//
// The two variables are read with literal names so Next can inline them into
// the browser bundle at build time.
export function supabaseEnvOrNull(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function supabaseEnv(): { url: string; anonKey: string } {
  const env = supabaseEnvOrNull();
  if (!env) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in apps/web/.env.local");
  }
  return env;
}
