// Adversary r4f: after a wallet creation whose outcome is unknown, /wallet still
// offers "Create wallet with a passkey" unless the message is byte-for-byte the
// one string WALLET_MAYBE_CREATED.
//
// Spec: docs/decisions.md 2026-11-26 (r4e row): "After 'could not confirm
// whether your wallet was created', only Connect is offered, not Create"; and
// (r3e/r3g rows) any answer that does not prove a refusal before sending must
// make the person check with Connect "before creating another wallet".
// Cause: apps/web/src/app/wallet/page.tsx hides Create only when
// `state.message === WALLET_MAYBE_CREATED`. The relay's own message carries a
// detail in brackets for most unclear answers ("... was created (WAIT_TIMEOUT).
// Before creating another, reload ..."), and the kit's own failures (the
// platform's 504 page, a dropped connection) carry other text. Each is shown
// with the Create button right under "Before creating another ...".
//
// The messages here come from the real code: the real /api/relay route (with
// SDF's proxy stood in by a local fetch stub) answering the real
// smart-account-kit RelayerClient, whose error the page's create() receives the
// way kit.createWallet returns it (submitResult { success: false, error }).
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { RelayerClient } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { SHARED_DEPLOYER, walletCtorArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const RELAY = "http://relay.test/api/relay";
const CREATE = "Create wallet with a passkey";

function walletDeploy() {
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), salt: Buffer.alloc(32, 7) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")),
    constructorArgs: walletCtorArgs(),
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args),
      subInvocations: [],
    }),
  });
  return { func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"), auth: [entry.toXDR("base64")] };
}

/**
 * What the kit returns from createWallet({ autoSubmit: true }) when SDF's proxy
 * (behind the real relay route) answers `proxy`, or when the relay route itself
 * is answered by `platform` instead (a gateway in front of it).
 */
async function kitFailure(opts: { proxy?: () => Response; platform?: () => Response }): Promise<string> {
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [] })) as never);
  const { POST } = await import("../src/app/api/relay/route");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === RELAY) return opts.platform ? opts.platform() : POST(new Request(RELAY, init));
      return opts.proxy!();
    }),
  );
  const { func, auth } = walletDeploy();
  const r = await new RelayerClient(RELAY).send(func, auth);
  expect(r.success).toBe(false);
  return (r as { error: string }).error;
}

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
  if (typeof click === "function" && own.includes(text)) return click;
  return clickHandlerFor(kids, text);
}

type Wallet = { kind: string; message?: string };
const A = { id: "A", email: "a@x.ng" };
const quiet = () => ({ data: { subscription: { unsubscribe() {} } } });

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], createWallet?: () => Promise<unknown>) {
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
      useEffect: () => {},
    };
  });
  const auth = { getUser: async () => ({ data: { user: A }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: quiet, signOut: async () => ({ error: null }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: () => Promise.resolve({ disconnect: async () => {}, connectWallet: async () => null, createWallet }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), setters };
}

/** Clicks Create with a kit whose createWallet fails with `message`, and returns what the page then shows. */
async function shownAfterCreateFails(message: string): Promise<string> {
  const failing = async () => ({ contractId: "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX", submitResult: { success: false, error: new Error(message) } });
  const { tree, setters } = await renderWallet([{ kind: "idle" }, "", A], failing);
  await clickHandlerFor(tree, CREATE)!();
  const state = setters.filter((s) => s.i === 0).map((s) => s.v as Wallet).at(-1)!;
  expect(state.kind).toBe("error");
  expect(state.message).toBe(message);
  vi.resetModules();
  const { tree: after } = await renderWallet([state, "", A]);
  return texts(after).join(" | ");
}

describe("adversary r4f: Create is offered after an unknown wallet-creation outcome", () => {
  it("control: an unclear proxy answer with no detail hides Create (the case r4e fixed)", async () => {
    const message = await kitFailure({ proxy: () => new Response(null, { status: 204 }) });
    expect(message).toMatch(/Before creating another, reload the page and check with Connect/);
    const shown = await shownAfterCreateFails(message);
    expect(shown).toContain("I already have a wallet"); // Connect is offered
    expect(shown).not.toContain(CREATE);
  });

  it("the proxy timing out (WAIT_TIMEOUT) says to check first, yet Create is still offered", async () => {
    const message = await kitFailure({ proxy: () => Response.json({ success: false, data: { code: "WAIT_TIMEOUT" } }, { status: 504 }) });
    expect(message).toMatch(/could not confirm whether your wallet was created \(WAIT_TIMEOUT\)\. Before creating another, reload the page and check with Connect/);
    const shown = await shownAfterCreateFails(message);
    expect(shown).toContain("I already have a wallet");
    expect(shown).not.toContain(CREATE);
  });

  it("a gateway 504 page in front of the relay (it may have submitted) still offers Create", async () => {
    const message = await kitFailure({ platform: () => new Response("<html>504 Gateway Timeout</html>", { status: 504, headers: { "Content-Type": "text/html" } }) });
    expect(message).toBe("Relayer request failed with status 504");
    const shown = await shownAfterCreateFails(message);
    expect(shown).not.toContain(CREATE);
  });
});
