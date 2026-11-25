// Supabase sends sign-in errors to the site root. Pass them to /signin, which
// shows them; otherwise start there.
export function GET(request: Request) {
  const url = new URL(request.url);
  const msg = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const to = new URL("/signin", url.origin);
  if (msg) to.searchParams.set("error", msg);
  return Response.redirect(to, 307);
}
