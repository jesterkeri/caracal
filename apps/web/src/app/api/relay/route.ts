// Fee sponsorship relay. The browser's smart-account-kit posts
// { func, auth } or { xdr } here, and this server forwards it to a relayer
// that pays the network fee. The relayer can only pay fees: every payload is
// already authorised by the user's passkey, and the relayer holds no user
// funds or keys.
//
// Testnet default: SDF's public smart-account relayer proxy, which forwards
// to OpenZeppelin Channels. Set RELAYER_UPSTREAM to point at our own relayer
// later. Calling it from the server means no browser CORS and no key in the
// bundle.

const DEFAULT_UPSTREAM = "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev";
const MAX_BODY_BYTES = 64 * 1024;

function isPayload(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.xdr === "string") return Object.keys(o).length === 1;
  return (
    typeof o.func === "string" &&
    Array.isArray(o.auth) &&
    o.auth.every((a) => typeof a === "string") &&
    Object.keys(o).length === 2
  );
}

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ success: false, error: "Payload too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ success: false, error: "Body is not JSON" }, { status: 400 });
  }
  if (!isPayload(body)) {
    return Response.json(
      { success: false, error: "Expected { func, auth } or { xdr }" },
      { status: 400 },
    );
  }

  const upstream = process.env.RELAYER_UPSTREAM ?? DEFAULT_UPSTREAM;
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const cause = e instanceof Error ? ((e.cause as { code?: string } | undefined)?.code ?? e.message) : String(e);
    console.error("relay upstream unreachable:", cause);
    return Response.json(
      { success: false, error: "The fee relayer could not be reached. Try again." },
      { status: 502 },
    );
  }
  const out = await res.text();
  return new Response(out, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}
