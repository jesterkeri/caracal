// Supabase sends some sign-in errors to the site root. Pass them on to /signin
// as a known code (never the upstream text); otherwise start there.
import { signinUrl, upstreamErrorCode } from "@/lib/auth/signin-errors";

export function GET(request: Request) {
  const url = new URL(request.url);
  const code = upstreamErrorCode(url.searchParams);
  if (code) console.error("sign-in error at root:", url.searchParams.get("error_code") ?? url.searchParams.get("error"));
  return Response.redirect(signinUrl(url.origin, code), 307);
}
