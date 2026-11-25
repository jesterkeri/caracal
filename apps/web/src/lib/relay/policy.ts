// Sponsorship policy for /api/relay. Pure apart from the injected wasm lookup,
// so it can be tested without a network.
//
// The relayer pays fees from its own account and submits the transaction as
// that account. So this policy decides exactly what Caracal is willing to pay
// for, and refuses everything else before it reaches the relayer:
// - only { func, auth } payloads (the kit sends nothing else on our path);
// - every auth entry carries address credentials (V1 or V2). A source-account
//   credential would make the relayer's own account the authoriser, and
//   delegate credentials are not supported by the wallet kit either;
// - the host function, and every node of every auth entry's invocation tree,
//   must be an allowed call:
//   a) creating a contract from a wasm on the deploy allowlist;
//   b) calling an allowed function on the USDC SAC (transfer);
//   c) calling an allowed function on a contract whose on-chain wasm is on the
//      allowlist. A smart wallet's `execute(target, fn, args)` is followed one
//      level: the inner call must itself be allowed, and cannot be another
//      `execute`.

import { Address, xdr } from "@stellar/stellar-sdk";

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_AUTH_ENTRIES = 8;
const MAX_INVOCATION_NODES = 32;

export type Policy = {
  /** wasm hash (lower-case hex) -> functions Caracal sponsors on contracts running it. */
  wasmFunctions: ReadonlyMap<string, ReadonlySet<string>>;
  /** wasm hashes Caracal sponsors deploying. */
  deployable: ReadonlySet<string>;
  /** wasm hashes whose `execute(target, fn, args)` forwards a call that is then checked. */
  executors: ReadonlySet<string>;
  /** Stellar asset contracts -> functions sponsored on each. */
  sacFunctions: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Returns the wasm hash (lower-case hex) of a deployed contract, or null if it has none. */
export type WasmLookup = (contractId: string) => Promise<string | null>;

export type Verdict =
  | { ok: true; body: { func: string; auth: string[] } }
  | { ok: false; status: number; error: string };

class Denied extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

const ADDRESS_CREDENTIALS = new Set(["sorobanCredentialsAddress", "sorobanCredentialsAddressV2"]);

function strkey(a: xdr.ScAddress): string {
  try {
    return Address.fromScAddress(a).toString();
  } catch {
    throw new Denied("Unsupported address type", 400);
  }
}

function checkDeploy(exe: xdr.ContractExecutable, policy: Policy) {
  if (exe.switch().name !== "contractExecutableWasm") {
    throw new Denied("Only wasm contracts on the allowlist can be deployed");
  }
  if (!policy.deployable.has(exe.wasmHash().toString("hex"))) {
    throw new Denied("This contract code is not on the sponsorship allowlist");
  }
}

async function checkCall(
  target: string,
  fn: string,
  args: xdr.ScVal[],
  policy: Policy,
  lookupWasm: WasmLookup,
  viaExecute: boolean,
): Promise<void> {
  const sacFns = policy.sacFunctions.get(target);
  if (sacFns) {
    if (!sacFns.has(fn)) throw new Denied(`${fn} is not sponsored on this token`);
    return;
  }
  if (!target.startsWith("C")) throw new Denied("Calls must target a contract");
  let hash: string | null;
  try {
    hash = await lookupWasm(target);
  } catch {
    throw new Denied("Could not check the target contract. Try again.", 503);
  }
  const fns = hash === null ? undefined : policy.wasmFunctions.get(hash);
  if (!fns) throw new Denied("This contract is not on the sponsorship allowlist");
  if (!fns.has(fn)) throw new Denied(`${fn} is not sponsored on this contract`);

  if (fn === "execute" && policy.executors.has(hash!)) {
    if (viaExecute) throw new Denied("Nested execute is not sponsored");
    const [t, f, a] = args;
    if (args.length !== 3 || t?.switch().name !== "scvAddress" || f?.switch().name !== "scvSymbol") {
      throw new Denied("execute must be (target, function, args)", 400);
    }
    const innerArgs = a?.switch().name === "scvVec" ? (a.vec() ?? []) : null;
    if (innerArgs === null) throw new Denied("execute args must be a vector", 400);
    await checkCall(strkey(t.address()), f.sym().toString(), innerArgs, policy, lookupWasm, true);
  }
}

async function checkInvocationTree(
  root: xdr.SorobanAuthorizedInvocation,
  policy: Policy,
  lookupWasm: WasmLookup,
  budget: { nodes: number },
): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const inv = stack.pop()!;
    if (++budget.nodes > MAX_INVOCATION_NODES) throw new Denied("Authorization tree is too large", 400);
    const f = inv.function();
    switch (f.switch().name) {
      case "sorobanAuthorizedFunctionTypeContractFn": {
        const c = f.contractFn();
        await checkCall(
          strkey(c.contractAddress()),
          c.functionName().toString(),
          c.args(),
          policy,
          lookupWasm,
          false,
        );
        break;
      }
      case "sorobanAuthorizedFunctionTypeCreateContractV2HostFn":
        checkDeploy(f.createContractV2HostFn().executable(), policy);
        break;
      default:
        throw new Denied("This authorization type is not sponsored");
    }
    stack.push(...inv.subInvocations());
  }
}

export async function checkPayload(
  body: unknown,
  policy: Policy,
  lookupWasm: WasmLookup,
): Promise<Verdict> {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Denied("Expected { func, auth }", 400);
    }
    const o = body as Record<string, unknown>;
    if (Object.keys(o).length !== 2 || typeof o.func !== "string" || !Array.isArray(o.auth)) {
      throw new Denied("Expected { func, auth }", 400);
    }
    const auth = o.auth;
    if (auth.length === 0) throw new Denied("At least one auth entry is required", 400);
    if (auth.length > MAX_AUTH_ENTRIES) throw new Denied("Too many auth entries", 400);

    const entries: xdr.SorobanAuthorizationEntry[] = [];
    for (const a of auth) {
      if (typeof a !== "string") throw new Denied("Auth entries must be base64 XDR strings", 400);
      let entry: xdr.SorobanAuthorizationEntry;
      try {
        entry = xdr.SorobanAuthorizationEntry.fromXDR(a, "base64");
      } catch {
        throw new Denied("An auth entry is not valid XDR", 400);
      }
      if (!ADDRESS_CREDENTIALS.has(entry.credentials().switch().name)) {
        throw new Denied("Every auth entry must be signed by an address, not the transaction source", 400);
      }
      entries.push(entry);
    }

    let fn: xdr.HostFunction;
    try {
      fn = xdr.HostFunction.fromXDR(o.func, "base64");
    } catch {
      throw new Denied("func is not valid XDR", 400);
    }
    switch (fn.switch().name) {
      case "hostFunctionTypeCreateContractV2":
        checkDeploy(fn.createContractV2().executable(), policy);
        break;
      case "hostFunctionTypeInvokeContract": {
        const c = fn.invokeContract();
        await checkCall(
          strkey(c.contractAddress()),
          c.functionName().toString(),
          c.args(),
          policy,
          lookupWasm,
          false,
        );
        break;
      }
      default:
        throw new Denied("Only contract calls and allowlisted deployments are sponsored");
    }

    const budget = { nodes: 0 };
    for (const e of entries) await checkInvocationTree(e.rootInvocation(), policy, lookupWasm, budget);

    return { ok: true, body: { func: o.func, auth: auth as string[] } };
  } catch (e) {
    if (e instanceof Denied) return { ok: false, status: e.status, error: e.message };
    return { ok: false, status: 400, error: "Malformed payload" };
  }
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
 * Fixed-window counter, in memory. It is a per-process burst control, not a
 * global budget: each server instance keeps its own count, and a restart
 * resets it. A shared quota needs a shared store (planned with the database).
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

/**
 * The client address to rate-limit by. Forwarded headers are trusted only
 * behind a proxy that overwrites them: on Vercel (VERCEL=1) or when
 * RELAY_TRUSTED_PROXY=1 is set. Otherwise every caller shares one bucket,
 * because a spoofable header must not hand out fresh quotas.
 */
export function clientKey(request: Request, env: Record<string, string | undefined>): string {
  const trusted = env.VERCEL === "1" || env.RELAY_TRUSTED_PROXY === "1";
  if (!trusted) return "untrusted-proxy";
  const xff = request.headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  return ip || "unknown";
}
