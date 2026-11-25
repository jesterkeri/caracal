// Fee sponsorship relay. The browser's smart-account-kit posts { func, auth }
// here, and this server forwards it to a relayer that pays the network fee.
//
// The relayer holds no user funds or keys, but it does pay real fees and
// submits as its own account. So before forwarding, this route enforces a
// sponsorship policy (src/lib/relay/policy.ts): bounded body, address-signed
// auth only, and only allowlisted deployments and contract calls. Rate limits
// are in memory, per server instance (testnet only; see policy.ts).
//
// Testnet default upstream: SDF's public smart-account relayer proxy, which
// forwards to OpenZeppelin Channels. Set RELAYER_UPSTREAM to use our own
// relayer. Calling it from the server means no browser CORS and no key in the
// bundle.

import { NETWORK, SMART_ACCOUNT, SPLIT, TOKENS } from "@/lib/stellar/config";
import { checkPayload, readBounded, WindowLimiter, type Policy } from "@/lib/relay/policy";
import { rpcWasmLookup } from "@/lib/relay/wasm-lookup";

const DEFAULT_UPSTREAM = "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev";

const POLICY: Policy = {
  wasmAllowlist: new Set([SMART_ACCOUNT.accountWasmHash, SPLIT.wasmHash]),
  sacAllowlist: new Map([[TOKENS.usdc, new Set(["transfer"])]]),
};

const lookupWasm = rpcWasmLookup(NETWORK.rpcUrl);
const perIp = new WindowLimiter(10, 60_000);
const global = new WindowLimiter(120, 60_000);

// On Vercel, x-forwarded-for is set by the platform. Elsewhere it can be
// spoofed, which is why the global limit also applies.
function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

const fail = (error: string, status: number) =>
  Response.json({ success: false, error }, { status });

export async function POST(request: Request) {
  if (!perIp.take(clientIp(request))) return fail("Too many requests. Wait a minute.", 429);
  if (!global.take("all")) return fail("The fee sponsor is busy. Try again shortly.", 429);

  const text = await readBounded(request);
  if (text === null) return fail("Payload too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("Body is not JSON", 400);
  }

  const verdict = await checkPayload(body, POLICY, lookupWasm);
  if (!verdict.ok) return fail(verdict.error, verdict.status);

  const upstream = process.env.RELAYER_UPSTREAM || DEFAULT_UPSTREAM;
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verdict.body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const cause = e instanceof Error ? ((e.cause as { code?: string } | undefined)?.code ?? e.message) : String(e);
    console.error("relay upstream unreachable:", cause);
    return fail("The fee relayer could not be reached. Try again.", 502);
  }
  const out = await res.text();
  return new Response(out, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}
