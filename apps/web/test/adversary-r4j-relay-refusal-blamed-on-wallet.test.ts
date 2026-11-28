// Adversary r4j: a wallet creation the relay refused before sending anything
// (rate limit, server not set up) is shown as "Your wallet may already exist",
// hides Create, and records a creation marker that outlives a reload.
//
// Spec: docs/decisions.md 2026-11-26 (r4f row): Create is offered again "only
// when the relay's own answer says 'Nothing was sent'; any other failure (a
// hash, a timeout, a gateway page, a refusal of unknown timing) keeps its own
// text, adds 'Your wallet may already exist'". Adversary r4a (test
// adversary-r4a-relay.test.ts) already held that a refusal known to be before
// sending must not send the person looking for a wallet.
// Goals 3 (told something false) and 4 (a state left only by clearing site
// data): a person with no wallet, who hit the relay's 429 or a server that is
// not set up, gets only "I already have a wallet", for good, because
// caracal.creationUnconfirmed stays set and Connect finds nothing.
// Cause: apps/web/src/app/api/relay/route.ts answers those refusals (lines
// 107-108, 123, and the 400s of the policy) without the words "Nothing was
// sent", which apps/web/src/app/wallet/page.tsx (the `detail.includes` check)
// is the only thing that lets Create come back.
import { Address, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { SHARED_DEPLOYER, walletCtorArgs } from "./relay-fixtures";
import { withLedger } from "./fake-ledger";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const CREATE = "Create wallet with a passkey";
const MAYBE = "Your wallet may already exist";
const MARKER = "caracal.creationUnconfirmed";

// ---- a real wallet-creation request, as the kit posts it ----
const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");
function walletDeploy() {
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), salt: Buffer.alloc(32, 7) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")),
    constructorArgs: walletCtorArgs(),
  });
  return {
    func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"),
    auth: [authBy(SHARED_DEPLOYER, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args))],
  };
}
const post = (body: string) => new Request("http://x/api/relay", { method: "POST", body });

/** What the relay answers a wallet creation, as the kit's relayer client reads it: the `error` string. */
async function relayAnswer(prepare?: (POST: (r: Request) => Promise<Response>) => Promise<void>): Promise<{ status: number; error: string }> {
  const { POST } = await import("../src/app/api/relay/route");
  await prepare?.(POST);
  const res = await POST(post(JSON.stringify(walletDeploy())));
  const body = (await res.json()) as { success: boolean; error: string };
  expect(body.success).toBe(false);
  return { status: res.status, error: body.error };
}

// ---- the wallet page, React stubbed (as in adversary-r4g) ----
type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function clickHandlerFor(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickHandlerFor(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const click = (node as El).props?.onClick;
  if (typeof click === "function" && own.trim() === text) return click;
  return clickHandlerFor(kids, text);
}

const A = { id: "A", email: "a@x.ng" };
const quiet = () => ({ data: { subscription: { unsubscribe() {} } } });
const settle = () => new Promise((r) => setTimeout(r, 20));
type Shown = { kind: string; message?: string; createAllowed?: boolean; checkFirst?: boolean; knownWallet?: boolean };

/** A kit whose passkey step succeeds and whose deploy goes through the real relay route, which refuses. */
function kitRefusedBy(error: string) {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    events: { on: (name: string, cb: () => void) => ((listeners[name] ??= []).push(cb), () => {}) },
    disconnect: async () => {},
    connectWallet: async () => null,
    // smart-account-kit 0.10.0 deploy-ops.js:160-162,184-193: a relayer answer with success false is thrown as
    // Error(relayerResult.error) and returned as { success: false, error } with no hash.
    createWallet: async () => {
      (listeners.credentialCreated ?? []).forEach((f) => f());
      return { contractId: "C".padEnd(56, "A"), submitResult: { success: false as const, error: new Error(error) } };
    },
  };
}

async function renderWallet(states: unknown[], store: Map<string, string>, kit: unknown) {
  const effects: (() => unknown)[] = [];
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: quiet,
    signOut: async () => ({ error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(kit)) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).map((s) => s.v as Shown).at(-1)!;

/** A person with no wallet and an empty store clicks Create; the kit's deploy is refused with `error`. Returns what they then see, and after a reload. */
async function afterCreateRefusedWith(error: string) {
  const store = new Map<string, string>();
  const kit = kitRefusedBy(error);
  const { tree, setters } = await renderWallet([{ kind: "idle" }, "", A], store, kit);
  expect(clickHandlerFor(tree, CREATE)).toBeTypeOf("function"); // harness: Create is offered to begin with
  await clickHandlerFor(tree, CREATE)!();
  await settle();
  const state = lastState(setters);
  vi.resetModules();
  const { tree: after } = await renderWallet([state, "", A], store, kit);
  const shown = texts(after).join(" | ");

  // The person reloads: the page's load effect runs against the same storage.
  vi.resetModules();
  const reloaded = await renderWallet([{ kind: "busy", label: "Checking for a saved wallet" }, "", null], store, kit);
  reloaded.effects.forEach((f) => f());
  await settle();
  const stateAfterReload = lastState(reloaded.setters);
  vi.resetModules();
  const { tree: reloadedTree } = await renderWallet([stateAfterReload, "", A], store, kit);
  return { state, shown, marker: store.get(MARKER), reloadShown: texts(reloadedTree).join(" | "), reloadState: stateAfterReload };
}

describe("adversary r4j: a refusal before anything was sent is not shown as a possible wallet", () => {
  it("control: a refusal that says 'Nothing was sent' offers Create again and leaves no marker", async () => {
    vi.stubEnv("RELAYER_UPSTREAM", "smart-account-relayer-proxy.sdf-ecosystem.workers.dev"); // not a URL: refused before sending
    const relay = await relayAnswer();
    expect(relay.error).toContain("Nothing was sent");
    const r = await afterCreateRefusedWith(relay.error);
    expect(r.shown).toContain(CREATE);
    expect(r.shown).not.toContain(MAYBE);
    expect(r.marker).toBeUndefined();
  });

  it("control: a refusal of unknown timing (empty proxy answer) keeps Create hidden and the marker set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => new Response(null, { status: 204 })) as never);
    const relay = await relayAnswer();
    fetchSpy.mockRestore();
    expect(relay.error).not.toContain("Nothing was sent");
    const r = await afterCreateRefusedWith(relay.error);
    expect(r.shown).not.toContain(CREATE);
    expect(r.shown).toContain("check with Connect"); // the relay's own text already says it
    expect(r.marker).toBe("A");
  });

  it("the relay's rate limit (429, answered before reading anything) is not shown as a possible wallet", async () => {
    // Every caller shares one bucket unless a trusted proxy is configured: 10 a minute.
    const relay = await relayAnswer(async (POST) => {
      for (let i = 0; i < 10; i++) await POST(post("not json"));
    });
    expect(relay.status).toBe(429);
    const r = await afterCreateRefusedWith(relay.error);
    expect(r.shown, `relay said: ${relay.error}`).toContain(CREATE);
    expect(r.shown).not.toContain(MAYBE);
  });

  it("a server that is not set up (503, nothing built or sent) is not shown as a possible wallet", async () => {
    vi.stubEnv("RELAY_SOURCE_SECRET", "");
    const relay = await relayAnswer();
    expect(relay.status).toBe(503);
    const r = await afterCreateRefusedWith(relay.error);
    expect(r.shown, `relay said: ${relay.error}`).toContain(CREATE);
    expect(r.shown).not.toContain(MAYBE);
  });

  it("after the 429, a reload still lets a person who has no wallet create one", async () => {
    const relay = await relayAnswer(async (POST) => {
      for (let i = 0; i < 10; i++) await POST(post("not json"));
    });
    const r = await afterCreateRefusedWith(relay.error);
    expect(r.marker, "caracal.creationUnconfirmed outlives a refusal that sent nothing").toBeUndefined();
    expect(r.reloadShown).toContain(CREATE);
  });
});
