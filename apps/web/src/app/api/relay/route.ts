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
// and any wasm that is not Caracal's (src/lib/relay/sponsor.ts). The shared
// deployer's wallet deployment is then forwarded as { func, auth }: its code
// hash is in the request and no existing contract's code runs.
// Everything except the shared deployer's wallet deployment is submitted as
// that pinned, signed transaction to OpenZeppelin Channels (CHANNELS_API_KEY,
// official client), which only adds a fee bump; without the key it is refused
// (fail closed).
//
// A request is sent upstream within SEND_DEADLINE_MS of arriving (on a
// monotonic clock, checked again just before sending), or not at all
// (refused, "Nothing was sent"), and never once its caller has gone. A wallet
// deployment is forwarded with its authorisation re-signed to expire
// DEPLOY_AUTH_LEDGERS after the simulation's ledger (deploy-auth.ts), so it
// cannot land in a later ledger. That is a bound in ledgers, not in time (a
// slow network closes them late): the wallet page waits for both before
// "start a new one anyway" (creation-marker.ts).
//
// Testnet default upstream: SDF's public smart-account relayer proxy, which
// forwards to OpenZeppelin Channels. Set RELAYER_UPSTREAM to use our own
// relayer. Calling it from the server means no browser CORS and no key in the
// bundle.

import { refusalText } from "@/lib/relay/refusal";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { NETWORK, SMART_ACCOUNT, SPLIT } from "@/lib/stellar/config";
import { CARACAL_POLICY } from "@/lib/relay/caracal-policy";
import { checkPayload, clientKey, readBounded, WindowLimiter } from "@/lib/relay/policy";
import { REFUSED_BEFORE_SUBMIT, channelsClient, codeOf, isTxHash, safeTransactionId, submitToChannels, type Submitter } from "@/lib/relay/channels";
import { buildSponsoredTx, serial, type SponsorDeps } from "@/lib/relay/sponsor";
import { isLoopback, rpcContractLookup } from "@/lib/relay/wasm-lookup";
import { DEPLOY_AUTH_LEDGERS, withShortDeployAuth } from "@/lib/relay/deploy-auth";
import { SEND_DEADLINE_MS } from "@/lib/relay/limits";

const DEFAULT_UPSTREAM = "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev";

/** The only wasm a sponsored transaction may run. USDC is a built-in asset contract with no wasm. */
const ALLOWED_CODE = new Set([SMART_ACCOUNT.accountWasmHash, SPLIT.wasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]);
/** 0.5 XLM. A passkey wallet deploy needs well under this. */
const MAX_RESOURCE_FEE = BigInt(5_000_000);

const chain = rpcContractLookup(NETWORK.rpcUrl);
const oneAtATime = serial();
let channelsFor: { key: string; client: Submitter } | null = null;
/** CHANNELS_TIMEOUT_MS: a whole number of milliseconds up to 10 minutes; anything else means the 60 s default. */
function channelsTimeout(): number {
  const raw = process.env.CHANNELS_TIMEOUT_MS;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 600_000) return n;
  if (raw) console.error("relay: CHANNELS_TIMEOUT_MS must be 1 to 600000 ms; using 60000");
  return 60_000;
}
/**
 * An upstream URL setting (CHANNELS_BASE_URL, RELAYER_UPSTREAM): unset means
 * the default; otherwise an https URL (plain http only on this machine). Null
 * when it is set to anything else, so the relay names the setting instead of
 * passing on an unclear error, or one that suggests something was sent.
 */
function upstreamUrl(name: "CHANNELS_BASE_URL" | "RELAYER_UPSTREAM"): string | undefined | null {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(raw))) return raw;
  } catch {}
  return null;
}
/** One Channels client per key and URL, built on first use. */
function channels(apiKey: string, baseUrl: string | undefined): Submitter {
  if (channelsFor?.key !== `${apiKey} ${baseUrl}`) {
    channelsFor = { key: `${apiKey} ${baseUrl}`, client: channelsClient(apiKey, baseUrl, channelsTimeout()) };
  }
  return channelsFor.client;
}
let sponsorDeps: SponsorDeps | null | undefined;

/** Built on first use. Null when RELAY_SOURCE_SECRET or the RPC URL is not set or not valid. */
function sponsor(): SponsorDeps | null {
  if (sponsorDeps !== undefined) return sponsorDeps;
  let source: Keypair;
  try {
    source = Keypair.fromSecret(process.env.RELAY_SOURCE_SECRET ?? "");
  } catch {
    console.error("relay: RELAY_SOURCE_SECRET is missing or invalid");
    return (sponsorDeps = null);
  }
  let server: rpc.Server;
  try {
    // Refuses http except on this machine (.env.example: https, except a local RPC).
    server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: isLoopback(NETWORK.rpcUrl) });
  } catch (e) {
    console.error("relay: NEXT_PUBLIC_STELLAR_RPC_URL is not usable:", e instanceof Error ? e.message : String(e));
    return (sponsorDeps = null);
  }
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

const refuse = (error: string, status: number) => fail(refusalText(error), status);

export async function POST(request: Request) {
  // A monotonic clock: setting the system clock back cannot stretch the deadline.
  const arrived = performance.now();
  /** Refusal if this request may no longer be sent: too late, or its caller has gone. */
  const tooLate = () =>
    request.signal?.aborted
      ? refuse("The request was cancelled before it was sent", 499)
      : performance.now() - arrived > SEND_DEADLINE_MS
        ? refuse("The fee sponsor is busy. Try again in a minute.", 503)
        : null;
  if (!perIp.take(clientKey(request, process.env))) return refuse("Too many requests. Wait a minute.", 429);
  if (!perInstance.take("all")) return refuse("The fee sponsor is busy. Try again shortly.", 429);

  let text: string | null;
  try {
    text = await readBounded(request);
  } catch {
    // The client's body stream broke (connection reset, aborted upload).
    return refuse("The request body could not be read", 400);
  }
  if (text === null) return refuse("Payload too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse("Body is not JSON", 400);
  }

  // Setup first: an unusable secret or RPC URL is "not set up" on every path.
  const deps = sponsor();
  if (!deps) return refuse("Fee sponsorship is not set up on this server.", 503);

  const verdict = await checkPayload(body, CARACAL_POLICY, chain.wasm, chain.instance);
  // Every refusal here is made before anything is sent, so it says "Nothing
  // was sent": the wallet page needs it to offer creation again, and the
  // invoice and split pages need it to tell a refusal from a lost answer.
  if (!verdict.ok) return refuse(verdict.error, verdict.status);

  // Only the shared deployer's wallet deployment goes to SDF's proxy as
  // { func, auth }: it names its exact code hash and no existing contract's
  // code runs, so nothing can change after the check. Everything else (calls,
  // and deployments a passkey wallet authorises, which run that wallet's
  // __check_auth) must run as the transaction built, pinned and signed here.
  // SDF's proxy refuses those, so they go to OpenZeppelin Channels with
  // Caracal's own key, which only adds the fee bump.
  const fn = xdr.HostFunction.fromXDR(verdict.body.func, "base64");
  const toProxy =
    fn.switch().name === "hostFunctionTypeCreateContractV2" &&
    verdict.body.auth.every((a) => {
      const cr = xdr.SorobanAuthorizationEntry.fromXDR(a, "base64").credentials();
      const addr = cr.switch().name === "sorobanCredentialsAddressV2" ? cr.addressV2().address() : cr.address().address();
      return addr.switch().name === "scAddressTypeAccount";
    });
  const channelsKey = process.env.CHANNELS_API_KEY;
  if (!toProxy && !channelsKey) {
    return refuse("Sponsored contract calls are not set up on this server yet (CHANNELS_API_KEY). Wallet creation works.", 503);
  }
  // Sent as an HTTP header: a pasted space, newline or non-ASCII character
  // would make every request fail with an error that does not name the key.
  if (!toProxy && !/^[\x21-\x7e]+$/.test(channelsKey!)) {
    console.error("relay: CHANNELS_API_KEY must be printable ASCII with no spaces or newlines");
    return refuse("Sponsored contract calls are not set up correctly on this server (CHANNELS_API_KEY). Wallet creation works.", 503);
  }
  const channelsUrl = toProxy ? undefined : upstreamUrl("CHANNELS_BASE_URL");
  if (channelsUrl === null) {
    console.error("relay: CHANNELS_BASE_URL must be an https URL (http only on this machine)");
    return refuse("Sponsored contract calls are not set up correctly on this server (CHANNELS_BASE_URL). Wallet creation works.", 503);
  }
  const proxyUrl = toProxy ? upstreamUrl("RELAYER_UPSTREAM") : undefined;
  if (proxyUrl === null) {
    console.error("relay: RELAYER_UPSTREAM must be an https URL (http only on this machine)");
    return refuse("Wallet creation is not set up correctly on this server (RELAYER_UPSTREAM). Nothing was sent.", 503);
  }

  // One at a time: each transaction takes the source account's next sequence
  // number, and the upstream answers only once it is on chain. Every chain
  // and relayer call inside is time-bounded, so one hung call cannot hold the
  // queue (sponsor.ts and the 60 s relayer timeouts).
  const answer = await oneAtATime(async (): Promise<Response | { res: Response; out: string }> => {
    // Waiting in the queue (or on the policy's lookups) is bounded: a request
    // that waited too long, or whose caller has gone, is not sent.
    const waited = tooLate();
    if (waited) return waited;
    let built;
    try {
      built = await buildSponsoredTx(verdict.body, deps);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error("relay could not build the transaction:", why);
      // stellar-sdk's getAccount reports every failure (unreachable RPC or an
      // account that does not exist) as "Account not found", so both are named.
      if (why.startsWith("Account not found")) {
        return refuse("Caracal could not load its fee account from the network: either the network could not be reached, or the fee account (RELAY_SOURCE_SECRET) is not funded on testnet. Nothing was sent.", 503);
      }
      return refuse("The network could not be reached to check this call. Try again.", 503);
    }
    // Simulated with every signature enforced and every wasm checked; see sponsor.ts.
    if (!built.ok) return refuse(built.error, built.status);
    const late = tooLate();
    if (late) return late;

    if (!toProxy) {
      const sent = await submitToChannels(channels(channelsKey!, channelsUrl), built.xdr, channelsTimeout());
      return sent.ok ? Response.json({ success: true, data: sent.data }) : fail(sent.error, sent.status);
    }
    let forwarded: { func: string; auth: string[] };
    try {
      forwarded = await withShortDeployAuth(verdict.body, built.latestLedger + DEPLOY_AUTH_LEDGERS, NETWORK.passphrase);
    } catch (e) {
      console.error("relay could not re-sign the deployment:", e instanceof Error ? e.message : String(e));
      return refuse("Caracal could not prepare this wallet creation", 400);
    }
    // Checked again just before sending: re-signing above is asynchronous.
    const atSend = tooLate();
    if (atSend) return atSend;
    try {
      // The timeout covers both the request and reading the answer.
      const res = await fetch(proxyUrl ?? DEFAULT_UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwarded),
        signal: AbortSignal.timeout(60_000),
      });
      return { res, out: await res.text() };
    } catch (e) {
      const cause = e instanceof Error ? ((e.cause as { code?: string } | undefined)?.code ?? e.message) : String(e);
      console.error("relay upstream failed:", cause);
      // It may have failed before sending, or timed out after the proxy
      // submitted: the wallet may exist, so the person checks first.
      return fail(walletUnconfirmed(null), 502);
    }
  });
  if (answer instanceof Response) return answer;
  const { res, out } = answer;
  // 204, 205 and 304 may not carry a body; Response throws if given one.
  // An empty answer (204, 205, 304) says nothing about whether the wallet was
  // created; the kit would show "Relayer request failed with status 204" and
  // invite a retry. Joshua's decision on r3h: treat it like any unclear answer.
  if (NULL_BODY_STATUSES.has(res.status) || out.trim() === "") {
    console.error("relay upstream answered", res.status, "with no body");
    return fail(walletUnconfirmed(null), 502);
  }
  // The wallet kit reads `success` from the answer. Anything that is not the
  // relayer's JSON (a CDN error page, an empty body) becomes our own 502.
  const parsed = relayerAnswer(out);
  if (!parsed) {
    console.error("relay upstream answered", res.status, "with an unreadable body");
    // A gateway error page can arrive after the proxy already submitted.
    return fail(walletUnconfirmed(null), 502);
  }
  // A refusal's wording is the upstream's, so it never reaches the user: only
  // a fixed message and, if it looks like one, the upstream's error code.
  if (!parsed.success) {
    console.error("relay upstream refused:", res.status, out.slice(0, 300));
    const code = codeOf(parsed.data);
    const status = res.status >= 400 ? res.status : 502;
    if (code && REFUSED_BEFORE_SUBMIT.has(code)) {
      return fail(`The fee relayer refused to create this wallet (${code}). Nothing was sent. Try again.`, status);
    }
    return fail(walletUnconfirmed(code), status);
  }
  // As on the Channels path, only a confirmed transaction with a hash is a
  // created wallet; the answer is rebuilt from those fields, not passed on.
  const d = (parsed.data ?? {}) as { transactionId?: unknown; hash?: unknown; status?: unknown };
  if (!isTxHash(d.hash) || d.status !== "confirmed") {
    const status = typeof d.status === "string" && /^[a-z_]{1,20}$/.test(d.status) ? d.status : null;
    console.error("relay upstream answered success without a confirmed transaction:", out.slice(0, 300));
    return fail(walletUnconfirmed(status ? `status: ${status}` : null), 502);
  }
  return Response.json({ success: true, data: { transactionId: safeTransactionId(d.transactionId), hash: d.hash, status: "confirmed" } }, { status: 200 });
}

/**
 * The outcome of a wallet creation is unknown. A retry would make a second
 * passkey and wallet, so the person first checks whether the first one exists.
 */
function walletUnconfirmed(detail: string | null): string {
  return `Caracal could not confirm whether your wallet was created${detail ? ` (${detail})` : ""}. Before creating another, reload the page and check with Connect, using your passkey.`;
}

function relayerAnswer(text: string): { success: boolean; data?: unknown } | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && typeof (v as { success?: unknown }).success === "boolean" ? (v as { success: boolean; data?: unknown }) : null;
  } catch {
    return null;
  }
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
