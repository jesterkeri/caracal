// Public Supabase settings. The anon key is designed to be shipped to the
// browser; row-level security protects the data. The service role key is never
// imported in app code that reaches the browser.
//
// The two variables are read with literal names so Next can inline them into
// the browser bundle at build time.
//
// Null unless both are set and the URL is one supabase-js accepts (an http or
// https URL), so an unedited placeholder such as https://<project-ref>.supabase.co
// gives the "not set up" message instead of a crash.
export function supabaseEnvOrNull(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey && usableUrl(url) ? { url, anonKey } : null;
}

function usableUrl(url: string): boolean {
  // supabase-js itself requires http:// or https:// (so not "https:host"),
  // then parses the URL; both checks are mirrored here.
  if (!/^https?:\/\//i.test(url.trim())) return false;
  try {
    new URL(url.trim());
    return true;
  } catch {
    return false;
  }
}

export function supabaseEnv(): { url: string; anonKey: string } {
  const env = supabaseEnvOrNull();
  if (!env) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL (an https URL) and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in apps/web/.env.local");
  }
  return env;
}
