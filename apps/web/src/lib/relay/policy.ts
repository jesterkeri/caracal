// Sponsorship policy for /api/relay. Pure apart from the injected wasm lookup,
// so it can be tested without a network.
//
// The relayer pays fees from its own account and submits the transaction as
// that account. So this policy decides what Caracal is willing to pay for:
// - only { func, auth } payloads (the kit sends nothing else on our path),
// - every auth entry must carry address credentials. A source-account
//   credential would make the relayer's own account the authoriser,
// - the host function must be one of:
//   a) createContractV2 of a wasm on the allowlist (a passkey account or a
//      Caracal split contract),
//   b) invokeContract on the USDC SAC (transfer only), or on a contract whose
//      wasm hash is on the allowlist.
// Anything else is refused before it reaches the relayer.

import { Address, xdr } from "@stellar/stellar-sdk";

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_AUTH_ENTRIES = 8;

export type Policy = {
  /** Lower-case hex sha256 hashes of wasm Caracal will deploy or call. */
  wasmAllowlist: ReadonlySet<string>;
  /** Stellar asset contracts Caracal will call, with the functions allowed on each. */
  sacAllowlist: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Returns the wasm hash (lower-case hex) of a deployed contract, or null if it has none. */
export type WasmLookup = (contractId: string) => Promise<string | null>;

export type Verdict =
  | { ok: true; body: { func: string; auth: string[] } }
  | { ok: false; status: number; error: string };

const deny = (error: string, status = 400): Verdict => ({ ok: false, status, error });

export async function checkPayload(
  body: unknown,
  policy: Policy,
  lookupWasm: WasmLookup,
): Promise<Verdict> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return deny("Expected { func, auth }");
  }
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || typeof o.func !== "string" || !Array.isArray(o.auth)) {
    return deny("Expected { func, auth }");
  }
  const auth = o.auth;
  if (auth.length === 0) return deny("At least one auth entry is required");
  if (auth.length > MAX_AUTH_ENTRIES) return deny("Too many auth entries");

  for (const a of auth) {
    if (typeof a !== "string") return deny("Auth entries must be base64 XDR strings");
    let entry: xdr.SorobanAuthorizationEntry;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXDR(a, "base64");
    } catch {
      return deny("An auth entry is not valid XDR");
    }
    if (entry.credentials().switch().name !== "sorobanCredentialsAddress") {
      return deny("Every auth entry must be signed by an address, not the transaction source");
    }
  }

  let fn: xdr.HostFunction;
  try {
    fn = xdr.HostFunction.fromXDR(o.func, "base64");
  } catch {
    return deny("func is not valid XDR");
  }

  switch (fn.switch().name) {
    case "hostFunctionTypeCreateContractV2": {
      const exe = fn.createContractV2().executable();
      if (exe.switch().name !== "contractExecutableWasm") {
        return deny("Only wasm contracts on the allowlist can be deployed", 403);
      }
      const hash = exe.wasmHash().toString("hex");
      if (!policy.wasmAllowlist.has(hash)) {
        return deny("This contract code is not on the sponsorship allowlist", 403);
      }
      break;
    }
    case "hostFunctionTypeInvokeContract": {
      const args = fn.invokeContract();
      const target = Address.fromScAddress(args.contractAddress()).toString();
      const fnName = args.functionName().toString();
      const sacFns = policy.sacAllowlist.get(target);
      if (sacFns) {
        if (!sacFns.has(fnName)) {
          return deny(`Only ${[...sacFns].join(", ")} is sponsored on this token`, 403);
        }
        break;
      }
      if (!target.startsWith("C")) return deny("Calls must target a contract", 403);
      let hash: string | null;
      try {
        hash = await lookupWasm(target);
      } catch {
        return deny("Could not check the target contract. Try again.", 503);
      }
      if (hash === null || !policy.wasmAllowlist.has(hash)) {
        return deny("This contract is not on the sponsorship allowlist", 403);
      }
      break;
    }
    default:
      return deny("Only contract calls and allowlisted deployments are sponsored", 403);
  }

  return { ok: true, body: { func: o.func, auth: auth as string[] } };
}

/**
 * Reads a request body as text, stopping once it passes `max` bytes, so a huge
 * body is never buffered whole. Returns null when the limit is exceeded.
 */
export async function readBounded(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Fixed-window counter. In memory, so on a serverless host each instance keeps
 * its own count: it limits bursts per instance, not a true global budget. Good
 * enough for testnet; mainnet needs a shared store.
 */
export class WindowLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit for `key`; returns false when the key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (!h && this.hits.size >= this.maxKeys) this.sweep(now);
      if (!h && this.hits.size >= this.maxKeys) return false;
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    if (h.n >= this.limit) return false;
    h.n += 1;
    return true;
  }

  private sweep(now: number) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}
