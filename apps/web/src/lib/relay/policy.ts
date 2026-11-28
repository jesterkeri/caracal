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
import { cancelQuietly } from "../cancel-quietly";

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_AUTH_ENTRIES = 8;
const MAX_INVOCATION_NODES = 32;

/** What a rule can ask about the chain. */
export type Ctx = {
  /** True when `address` is a contract running a wasm in `policy.executors` (a passkey wallet). */
  isWallet(address: string): Promise<boolean>;
};
/** Returns a refusal reason, or null when the arguments are acceptable. */
export type ArgsRule = (args: xdr.ScVal[], ctx: Ctx) => Promise<string | null>;
/** Checks a deployed contract's instance storage. Returns a refusal reason or null. */
export type StorageRule = (storage: xdr.ScMapEntry[], ctx: Ctx) => Promise<string | null>;

export type Policy = {
  /** wasm hash (lower-case hex) -> functions Caracal sponsors on contracts running it. */
  wasmFunctions: ReadonlyMap<string, ReadonlySet<string>>;
  /** wasm hashes Caracal sponsors deploying, each with a check of its constructor arguments. */
  deployable: ReadonlyMap<string, ArgsRule>;
  /** Classic (G) accounts allowed to sign, each with the wasm hashes it may deploy (the wallet kit's shared deployer). */
  deployerAuth: ReadonlyMap<string, ReadonlySet<string>>;
  /** wasm hashes whose `execute(target, fn, args)` forwards a call that is then checked. These are the wallets. */
  executors: ReadonlySet<string>;
  /** Stellar asset contracts -> functions sponsored on each. */
  sacFunctions: ReadonlyMap<string, ReadonlySet<string>>;
  /** `${contractId or wasm hash}:${fn}` -> check of that call's arguments. */
  callRules: ReadonlyMap<string, ArgsRule>;
  /** wasm hash -> check of a deployed contract's instance storage before any call to it. */
  storageRules: ReadonlyMap<string, StorageRule>;
};

/**
 * Returns the wasm hash (lower-case hex) of a deployed contract, or null if it
 * runs no wasm (a Stellar asset contract). Throws ContractNotFound when the
 * network has no instance entry for it.
 */
export type WasmLookup = (contractId: string) => Promise<string | null>;
/** Returns a deployed contract's instance storage, or null if it has none. Throws ContractNotFound like WasmLookup. */
export type InstanceLookup = (contractId: string) => Promise<xdr.ScMapEntry[] | null>;

/**
 * The RPC found no instance entry for a contract. That does not say why: the
 * address may be wrong or on another network, or the entry may have been
 * archived. So it is not proof that the contract runs some other code.
 */
export class ContractNotFound extends Error {
  constructor(readonly contractId: string) {
    super(`no instance entry on the network for ${contractId}`);
    this.name = "ContractNotFound";
  }
}

export const WALLET_NOT_FOUND =
  "Caracal could not find this wallet on the Stellar network. Check that it is a testnet wallet. A wallet that has not been used for a long time may need restoring before it can be used again.";
export const CONTRACT_NOT_FOUND =
  "Caracal could not find this contract on the Stellar network. Check that it is a testnet contract. One that has not been used for a long time may need restoring before it can be used again.";

/** Runs a lookup, turning a missing contract into a 409 that names no cause, and any other failure into a 503. */
async function lookup<T>(what: "wallet" | "contract", run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ContractNotFound) throw new Denied(what === "wallet" ? WALLET_NOT_FOUND : CONTRACT_NOT_FOUND, 409);
    throw new Denied(what === "wallet" ? "Could not check a wallet. Try again." : "Could not check the target contract. Try again.", 503);
  }
}

/** The address inside an ScVal, or null when it is not an address. */
export function scAddress(v: xdr.ScVal | undefined): string | null {
  if (!v || v.switch().name !== "scvAddress") return null;
  try {
    return Address.fromScAddress(v.address()).toString();
  } catch {
    return null;
  }
}

/** Instance storage value under a contracttype enum key such as `Token` (stored as Vec[Symbol("Token")]). */
export function storageGet(storage: xdr.ScMapEntry[], variant: string): xdr.ScVal | undefined {
  for (const e of storage) {
    const k = e.key();
    if (k.switch().name !== "scvVec") continue;
    const parts = k.vec() ?? [];
    if (parts.length === 1 && parts[0]!.switch().name === "scvSymbol" && parts[0]!.sym().toString() === variant) {
      return e.val();
    }
  }
  return undefined;
}

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

/** The account a deployment is created from (its contract id preimage), or null for asset contracts. */
function deployer(c: xdr.CreateContractArgsV2): string | null {
  const pre = c.contractIdPreimage();
  if (pre.switch().name !== "contractIdPreimageFromAddress") return null;
  return strkey(pre.fromAddress().address());
}

/**
 * `signer` is the address whose auth entry covers this deployment. The deployer
 * in the preimage must be that same address: otherwise an unrelated account,
 * possibly the relayer as transaction source, would be the deployer.
 */
async function checkDeploy(c: xdr.CreateContractArgsV2, policy: Policy, ctx: Ctx, signer: string) {
  const from = deployer(c);
  if (from === null) throw new Denied("Only deployments from an address are sponsored");
  if (from !== signer) throw new Denied("The deployer must be the address that authorises the deployment");
  const exe = c.executable();
  if (exe.switch().name !== "contractExecutableWasm") {
    throw new Denied("Only wasm contracts on the allowlist can be deployed");
  }
  const rule = policy.deployable.get(exe.wasmHash().toString("hex"));
  if (!rule) throw new Denied("This contract code is not on the sponsorship allowlist");
  const bad = await rule(c.constructorArgs(), ctx);
  if (bad) throw new Denied(bad);
}

type Deps = { policy: Policy; lookupWasm: WasmLookup; lookupInstance: InstanceLookup; ctx: Ctx };

async function applyCallRule(key: string, args: xdr.ScVal[], d: Deps) {
  const rule = d.policy.callRules.get(key);
  if (!rule) return;
  const bad = await rule(args, d.ctx);
  if (bad) throw new Denied(bad);
}

async function checkCall(target: string, fn: string, args: xdr.ScVal[], d: Deps, viaExecute: boolean): Promise<void> {
  const { policy, lookupWasm } = d;
  const sacFns = policy.sacFunctions.get(target);
  if (sacFns) {
    if (!sacFns.has(fn)) throw new Denied(`${fn} is not sponsored on this token`);
    await applyCallRule(`${target}:${fn}`, args, d);
    return;
  }
  if (!target.startsWith("C")) throw new Denied("Calls must target a contract");
  const hash = await lookup("contract", () => lookupWasm(target));
  const fns = hash === null ? undefined : policy.wasmFunctions.get(hash);
  if (!fns) throw new Denied("This contract is not on the sponsorship allowlist");
  if (!fns.has(fn)) throw new Denied(`${fn} is not sponsored on this contract`);

  const storageRule = policy.storageRules.get(hash!);
  if (storageRule) {
    const storage = await lookup("contract", () => d.lookupInstance(target));
    const bad = await storageRule(storage ?? [], d.ctx);
    if (bad) throw new Denied(bad);
  }
  await applyCallRule(`${hash}:${fn}`, args, d);

  if (fn === "execute" && policy.executors.has(hash!)) {
    if (viaExecute) throw new Denied("Nested execute is not sponsored");
    const [t, f, a] = args;
    if (args.length !== 3 || t?.switch().name !== "scvAddress" || f?.switch().name !== "scvSymbol") {
      throw new Denied("execute must be (target, function, args)", 400);
    }
    const innerArgs = a?.switch().name === "scvVec" ? (a.vec() ?? []) : null;
    if (innerArgs === null) throw new Denied("execute args must be a vector", 400);
    await checkCall(strkey(t.address()), f.sym().toString(), innerArgs, d, true);
  }
}

async function checkInvocationTree(
  root: xdr.SorobanAuthorizedInvocation,
  signer: string,
  d: Deps,
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
        await checkCall(strkey(c.contractAddress()), c.functionName().toString(), c.args(), d, false);
        break;
      }
      case "sorobanAuthorizedFunctionTypeCreateContractV2HostFn":
        await checkDeploy(f.createContractV2HostFn(), d.policy, d.ctx, signer);
        break;
      default:
        throw new Denied("This authorization type is not sponsored");
    }
    stack.push(...inv.subInvocations());
  }
}

/**
 * Node's base64 decoder skips characters it does not know and stops at "=", so
 * a lenient decode could check different bytes than the upstream relayer
 * parses. The body is forwarded as received, so accept a string only if it is
 * exactly the canonical encoding of what was decoded.
 */
function canonical<T extends { toXDR(format: "base64"): string }>(value: T, received: string): T {
  if (value.toXDR("base64") !== received) throw new Error("not canonical base64 XDR");
  return value;
}

export async function checkPayload(
  body: unknown,
  policy: Policy,
  lookupWasm: WasmLookup,
  lookupInstance: InstanceLookup = async () => {
    throw new Error("no instance lookup");
  },
): Promise<Verdict> {
  const ctx: Ctx = {
    async isWallet(address) {
      if (!address.startsWith("C")) return false;
      // A missing instance entry is not a wrong wasm: the wallet may only be
      // archived, so it is refused with a message that names no cause.
      const h = await lookup("wallet", () => lookupWasm(address));
      return h !== null && policy.executors.has(h);
    },
  };
  const d: Deps = { policy, lookupWasm, lookupInstance, ctx };
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
        entry = canonical(xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"), a);
      } catch {
        throw new Denied("An auth entry is not valid XDR", 400);
      }
      if (!ADDRESS_CREDENTIALS.has(entry.credentials().switch().name)) {
        throw new Denied("Every auth entry must be signed by an address, not the transaction source", 400);
      }
      entries.push(entry);
    }

    // Who signs: a passkey wallet, or (only to deploy a wallet) the kit's shared deployer.
    const signers: string[] = [];
    for (const entry of entries) {
      const cr = entry.credentials();
      const signer = strkey((cr.switch().name === "sorobanCredentialsAddressV2" ? cr.addressV2() : cr.address()).address());
      signers.push(signer);
      if (signer.startsWith("C")) {
        if (!(await ctx.isWallet(signer))) throw new Denied("Only Caracal passkey wallets can sign sponsored calls");
        continue;
      }
      const root = entry.rootInvocation();
      const rf = root.function();
      const allowed = policy.deployerAuth.get(signer);
      const deploysWallet =
        allowed !== undefined &&
        rf.switch().name === "sorobanAuthorizedFunctionTypeCreateContractV2HostFn" &&
        rf.createContractV2HostFn().executable().switch().name === "contractExecutableWasm" &&
        allowed.has(rf.createContractV2HostFn().executable().wasmHash().toString("hex")) &&
        root.subInvocations().length === 0;
      if (!deploysWallet) throw new Denied("A classic account may only sign a wallet deployment");
    }

    let fn: xdr.HostFunction;
    try {
      fn = canonical(xdr.HostFunction.fromXDR(o.func, "base64"), o.func);
    } catch {
      throw new Denied("func is not valid XDR", 400);
    }
    switch (fn.switch().name) {
      case "hostFunctionTypeCreateContractV2": {
        const c = fn.createContractV2();
        // The deployer must explicitly authorise exactly this deployment with
        // its own auth entry, so the relayer's account is never the implicit
        // deployer.
        const from = deployer(c);
        const want = c.toXDR("base64");
        const authorised = entries.some((e, i) => {
          const rf = e.rootInvocation().function();
          return (
            signers[i] === from &&
            rf.switch().name === "sorobanAuthorizedFunctionTypeCreateContractV2HostFn" &&
            rf.createContractV2HostFn().toXDR("base64") === want
          );
        });
        if (!authorised) throw new Denied("The deployment is not authorised by its deployer");
        await checkDeploy(c, policy, ctx, from!);
        break;
      }
      case "hostFunctionTypeInvokeContract": {
        const c = fn.invokeContract();
        await checkCall(strkey(c.contractAddress()), c.functionName().toString(), c.args(), d, false);
        break;
      }
      default:
        throw new Denied("Only contract calls and allowlisted deployments are sponsored");
    }

    const budget = { nodes: 0 };
    for (let i = 0; i < entries.length; i++) await checkInvocationTree(entries[i]!.rootInvocation(), signers[i]!, d, budget);

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
export async function readBounded(request: Request, max = MAX_BODY_BYTES, signal?: AbortSignal): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // With `signal`, a body that stalls is given up when it aborts (a deadline, the caller going away), and the stream
  // is cancelled (Codex tax R5): the byte limit alone never ends a wait for the next chunk.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason ?? new Error("The request body was not read in time."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        cancelQuietly(() => reader.cancel());
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    cancelQuietly(() => reader.cancel());
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
    // A window also ends if the clock stepped back past its start (NTP, a
    // resumed VM); otherwise a full window would stay blocked for the step.
    if (!h || now - h.start >= this.windowMs || now < h.start) {
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
