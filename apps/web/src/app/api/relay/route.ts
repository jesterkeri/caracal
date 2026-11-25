// Fee sponsorship relay. The browser's smart-account-kit posts { func, auth }
// here, and this server forwards it to a relayer that pays the network fee.
//
// The relayer holds no user funds or keys, but it does pay real fees and
// submits as its own account. So before forwarding, this route enforces a
// sponsorship policy (src/lib/relay/policy.ts): bounded body, address-signed
// auth only, and only allowlisted deployments and allowlisted functions on
// allowlisted contracts, checked through every authorisation tree.
//
// Rate limits here are a per-process burst control, NOT a global sponsor
// budget: each server instance counts on its own and a restart resets it. The
// sponsor's real budget is whatever the upstream relayer enforces. A shared
// quota needs a shared store and is planned with the database.
//
// Testnet default upstream: SDF's public smart-account relayer proxy, which
// forwards to OpenZeppelin Channels. Set RELAYER_UPSTREAM to use our own
// relayer. Calling it from the server means no browser CORS and no key in the
// bundle.

import { NETWORK } from "@/lib/stellar/config";
import { CARACAL_POLICY } from "@/lib/relay/caracal-policy";
import { checkPayload, clientKey, readBounded, WindowLimiter } from "@/lib/relay/policy";
import { rpcContractLookup } from "@/lib/relay/wasm-lookup";

const DEFAULT_UPSTREAM = "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev";

const chain = rpcContractLookup(NETWORK.rpcUrl);
const perIp = new WindowLimiter(10, 60_000);
const perInstance = new WindowLimiter(120, 60_000);

const fail = (error: string, status: number) =>
  Response.json({ success: false, error }, { status });

export async function POST(request: Request) {
  if (!perIp.take(clientKey(request, process.env))) return fail("Too many requests. Wait a minute.", 429);
  if (!perInstance.take("all")) return fail("The fee sponsor is busy. Try again shortly.", 429);

  const text = await readBounded(request);
  if (text === null) return fail("Payload too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("Body is not JSON", 400);
  }

  const verdict = await checkPayload(body, CARACAL_POLICY, chain.wasm, chain.instance);
  if (!verdict.ok) return fail(verdict.error, verdict.status);

  const upstream = process.env.RELAYER_UPSTREAM || DEFAULT_UPSTREAM;
  let res: Response;
  let out: string;
  try {
    // The timeout covers both the request and reading the answer.
    res = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verdict.body),
      signal: AbortSignal.timeout(60_000),
    });
    out = await res.text();
  } catch (e) {
    const cause = e instanceof Error ? ((e.cause as { code?: string } | undefined)?.code ?? e.message) : String(e);
    console.error("relay upstream failed:", cause);
    return fail("The fee relayer could not be reached. Try again.", 502);
  }
  // 204, 205 and 304 may not carry a body; Response throws if given one.
  if (NULL_BODY_STATUSES.has(res.status)) return new Response(null, { status: res.status });
  return new Response(out, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
