// Supabase sends some sign-in errors, and sometimes the sign-in code, to the
// site root. Errors go on to /signin as a known code (never the upstream text);
// a code goes on to /auth/callback; otherwise start at /signin.
import { logSafe } from "@/lib/auth/log-safe";
import { signinUrl, upstreamErrorCode } from "@/lib/auth/signin-errors";

export function GET(request: Request) {
  const url = new URL(request.url);
  // Supabase sends the sign-in code to the site root if /auth/callback is not
  // on its redirect allow list. Finish sign-in instead of dropping it. Only
  // the code is passed on; the callback validates it.
  const authCode = url.searchParams.get("code");
  if (authCode && !url.searchParams.has("error")) {
    const next = new URL("/auth/callback", url.origin);
    next.searchParams.set("code", authCode);
    return Response.redirect(next.toString(), 307);
  }
  const code = upstreamErrorCode(url.searchParams);
  if (code) console.error("sign-in error at root:", logSafe(url.searchParams.get("error_code") ?? url.searchParams.get("error")));
  return Response.redirect(signinUrl(url.origin, code), 307);
}
