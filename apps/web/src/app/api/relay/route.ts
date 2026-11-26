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
// The route then builds the transaction itself with a relay-only testnet
// account and simulates it with every signature enforced, refusing junk auth
// and any wasm that is not Caracal's (src/lib/relay/sponsor.ts). Deployments
// are then forwarded as { func, auth }: their code hash is in the request.
// Calls to existing contracts are submitted as that pinned, signed
// transaction to OpenZeppelin Channels (CHANNELS_API_KEY), which only adds a
// fee bump; without the key they are refused (fail closed).
//
// Testnet default upstream: SDF's public smart-account relayer proxy, which
// forwards to OpenZeppelin Channels. Set RELAYER_UPSTREAM to use our own
// relayer. Calling it from the server means no browser CORS and no key in the
// bundle.

import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { NETWORK, SMART_ACCOUNT, SPLIT } from "@/lib/stellar/config";
import { CARACAL_POLICY } from "@/lib/relay/caracal-policy";
import { checkPayload, clientKey, readBounded, WindowLimiter } from "@/lib/relay/policy";
import { buildSponsoredTx, serial, type SponsorDeps } from "@/lib/relay/sponsor";
import { isLoopback, rpcContractLookup } from "@/lib/relay/wasm-lookup";

const DEFAULT_UPSTREAM = "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev";
const DEFAULT_CHANNELS = "https://channels.openzeppelin.com/testnet";

/** The only wasm a sponsored transaction may run. USDC is a built-in asset contract with no wasm. */
const ALLOWED_CODE = new Set([SMART_ACCOUNT.accountWasmHash, SPLIT.wasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]);
/** 0.5 XLM. A passkey wallet deploy needs well under this. */
const MAX_RESOURCE_FEE = BigInt(5_000_000);

const chain = rpcContractLookup(NETWORK.rpcUrl);
const oneAtATime = serial();
let sponsorDeps: SponsorDeps | null | undefined;

/** Built on first use. Null when RELAY_SOURCE_SECRET is not set or not valid. */
function sponsor(): SponsorDeps | null {
  if (sponsorDeps !== undefined) return sponsorDeps;
  let source: Keypair;
  try {
    source = Keypair.fromSecret(process.env.RELAY_SOURCE_SECRET ?? "");
  } catch {
    console.error("relay: RELAY_SOURCE_SECRET is missing or invalid");
    return (sponsorDeps = null);
  }
  const server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: isLoopback(NETWORK.rpcUrl) });
  return (sponsorDeps = {
    source,
    networkPassphrase: NETWORK.passphrase,
    loadAccount: (id) => server.getAccount(id),
    simulate: (tx) => server.simulateTransaction(tx, undefined, "enforce"),
    allowedCode: ALLOWED_CODE,
    maxResourceFee: MAX_RESOURCE_FEE,
  });
}
const perIp = new WindowLimiter(10, 60_000);
const perInstance = new WindowLimiter(120, 60_000);

const fail = (error: string, status: number) =>
  Response.json({ success: false, error }, { status });

export async function POST(request: Request) {
  if (!perIp.take(clientKey(request, process.env))) return fail("Too many requests. Wait a minute.", 429);
  if (!perInstance.take("all")) return fail("The fee sponsor is busy. Try again shortly.", 429);

  let text: string | null;
  try {
    text = await readBounded(request);
  } catch {
    // The client's body stream broke (connection reset, aborted upload).
    return fail("The request body could not be read", 400);
  }
  if (text === null) return fail("Payload too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("Body is not JSON", 400);
  }

  const verdict = await checkPayload(body, CARACAL_POLICY, chain.wasm, chain.instance);
  if (!verdict.ok) return fail(verdict.error, verdict.status);

  const deps = sponsor();
  if (!deps) return fail("Fee sponsorship is not set up on this server.", 503);
  // A deployment names its exact code hash in the request, so the code that
  // runs cannot change after the check, and the proxy may build it from
  // { func, auth }. A call to an existing contract must run as the transaction
  // built, pinned and signed here; SDF's proxy refuses those, so they go to
  // OpenZeppelin Channels with Caracal's own key, which only adds the fee bump.
  const isDeploy = xdr.HostFunction.fromXDR(verdict.body.func, "base64").switch().name === "hostFunctionTypeCreateContractV2";
  const channelsKey = process.env.CHANNELS_API_KEY;
  if (!isDeploy && !channelsKey) {
    return fail("Sponsored contract calls are not set up on this server yet (CHANNELS_API_KEY). Wallet creation works.", 503);
  }

  // One at a time: each transaction takes the source account's next sequence
  // number, and the upstream answers only once it is on chain.
  const answer = await oneAtATime(async (): Promise<Response | { res: Response; out: string }> => {
    let built;
    try {
      built = await buildSponsoredTx(verdict.body, deps);
    } catch (e) {
      console.error("relay could not build the transaction:", e instanceof Error ? e.message : String(e));
      return fail("The network could not be reached to check this call. Try again.", 503);
    }
    // Simulated with every signature enforced and every wasm checked; see sponsor.ts.
    if (!built.ok) return fail(built.error, built.status);
    try {
      // Request shapes: SDF proxy takes { func, auth }. Channels' direct HTTP
      // API (as its official client, @openzeppelin/relayer-plugin-channels
      // 0.21.1, sends it) is POST <base>/ with { params: { xdr } } and a Bearer
      // key. Both answer { success, data: { transactionId, hash, status } }.
      const req: { url: string; headers: Record<string, string>; body: unknown } = isDeploy
        ? { url: process.env.RELAYER_UPSTREAM || DEFAULT_UPSTREAM, headers: {}, body: verdict.body }
        : {
            url: `${(process.env.CHANNELS_BASE_URL || DEFAULT_CHANNELS).replace(/\/+$/, "")}/`,
            headers: { Authorization: `Bearer ${channelsKey}` },
            body: { params: { xdr: built.xdr } },
          };
      // The timeout covers both the request and reading the answer.
      const res = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...req.headers },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(60_000),
      });
      return { res, out: await res.text() };
    } catch (e) {
      const cause = e instanceof Error ? ((e.cause as { code?: string } | undefined)?.code ?? e.message) : String(e);
      console.error("relay upstream failed:", cause);
      return fail("The fee relayer could not be reached. Try again.", 502);
    }
  });
  if (answer instanceof Response) return answer;
  const { res, out } = answer;
  // 204, 205 and 304 may not carry a body; Response throws if given one.
  if (NULL_BODY_STATUSES.has(res.status)) return new Response(null, { status: res.status });
  // The wallet kit reads `success` from the answer. Anything that is not the
  // relayer's JSON (a CDN error page, an empty body) becomes our own 502.
  if (!isRelayerAnswer(out)) {
    console.error("relay upstream answered", res.status, "with an unreadable body");
    return fail("The fee relayer gave an answer Caracal could not read. Try again.", 502);
  }
  return new Response(out, { status: res.status, headers: { "Content-Type": "application/json" } });
}

function isRelayerAnswer(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && typeof (v as { success?: unknown }).success === "boolean";
  } catch {
    return false;
  }
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
