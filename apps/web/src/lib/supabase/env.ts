// Public Supabase settings. The anon key is designed to be shipped to the
// browser; row-level security protects the data. The service role key is never
// imported in app code that reaches the browser.
export function supabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in apps/web/.env.local");
  }
  return { url, anonKey };
}
