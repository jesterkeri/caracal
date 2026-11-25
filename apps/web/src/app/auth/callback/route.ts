// Google sends the user back to Supabase, and Supabase sends them here with a
// one-time `code`. Exchanging it (PKCE) sets the session cookie. Opening this
// URL by hand has no code, so it shows an error instead of signing anyone in.
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const back = (msg: string) =>
    NextResponse.redirect(new URL(`/signin?error=${encodeURIComponent(msg)}`, url.origin));

  const upstreamError = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (upstreamError) return back(upstreamError);
  if (!code) return back("Sign-in was not started from Caracal. Use the Continue with Google button.");

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return back(error.message);
  return NextResponse.redirect(new URL("/wallet", url.origin));
}
