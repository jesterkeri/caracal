// Google sends the user back to Supabase, and Supabase sends them here with a
// one-time `code`. Exchanging it (PKCE) sets the session cookie. Opening this
// URL by hand has no code, so it shows an error instead of signing anyone in.
// Errors go to /signin as a known code, never as upstream text.
import { logSafe } from "@/lib/auth/log-safe";
import { NextResponse } from "next/server";
import { exchangeErrorCode, signinUrl, thrownExchangeErrorCode, upstreamErrorCode, type SigninErrorCode } from "@/lib/auth/signin-errors";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (code: SigninErrorCode) => NextResponse.redirect(signinUrl(url.origin, code));

  const upstream = upstreamErrorCode(url.searchParams);
  if (upstream) {
    console.error("sign-in error from Supabase:", logSafe(url.searchParams.get("error_code") ?? url.searchParams.get("error")));
    return back(upstream);
  }
  const code = url.searchParams.get("code");
  if (!code) return back("not_started");
  if (!supabaseEnvOrNull()) return back("config");

  let error: { code?: string; name?: string; status?: number; message: string } | null;
  try {
    const supabase = await supabaseServer();
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } catch (e) {
    // Named "unreachable" only when the throw shows the network or the 10 s
    // deadline; anything else is not blamed on the person's connection.
    console.error("sign-in code exchange threw:", e instanceof Error ? e.message : String(e));
    return back(thrownExchangeErrorCode(e));
  }
  if (error) {
    console.error("sign-in code exchange failed:", error.code ?? error.message);
    return back(exchangeErrorCode(error));
  }
  return NextResponse.redirect(new URL("/wallet", url.origin));
}
