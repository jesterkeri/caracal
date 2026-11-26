// Google sends the user back to Supabase, and Supabase sends them here with a
// one-time `code`. Exchanging it (PKCE) sets the session cookie. Opening this
// URL by hand has no code, so it shows an error instead of signing anyone in.
// Errors go to /signin as a known code, never as upstream text.
import { NextResponse } from "next/server";
import { signinUrl, upstreamErrorCode, type SigninErrorCode } from "@/lib/auth/signin-errors";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (code: SigninErrorCode) => NextResponse.redirect(signinUrl(url.origin, code));

  const upstream = upstreamErrorCode(url.searchParams);
  if (upstream) {
    console.error("sign-in error from Supabase:", url.searchParams.get("error_code") ?? url.searchParams.get("error"));
    return back(upstream);
  }
  const code = url.searchParams.get("code");
  if (!code) return back("not_started");
  if (!supabaseEnvOrNull()) return back("config");

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("sign-in code exchange failed:", error.code ?? error.message);
    return back("expired");
  }
  return NextResponse.redirect(new URL("/wallet", url.origin));
}
