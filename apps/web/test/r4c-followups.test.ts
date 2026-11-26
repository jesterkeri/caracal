// Follow-ups to adversary r4c's suspicions.
// - A code exchange that throws is "unreachable" only for a network failure or
//   the request deadline, never for a setup or program error.
// - The wallet page's account-changed label does not claim another tab.
// - The sign-in page, while it is still checking, offers Sign out and not a
//   second Google sign-in, and a check that ends after Sign out does not undo it.
// - A CHANNELS_API_KEY that cannot be sent as a header is named locally.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { thrownExchangeErrorCode } from "../src/lib/auth/signin-errors";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, transferArgs } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/supabase/server");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

describe("r4c follow-up: a code exchange that throws", () => {
  it.each([
    [new DOMException("Supabase did not answer in time", "TimeoutError"), "unreachable"],
    [new TypeError("fetch failed"), "unreachable"],
    [new Error("`cookies` was called outside a request scope"), "failed"],
    [new TypeError("Cannot read properties of undefined (reading 'auth')"), "failed"],
    ["a string", "failed"],
  ])("%s gives %s", (e, code) => expect(thrownExchangeErrorCode(e)).toBe(code));

  it("the callback route names a program error with the generic message", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    vi.doMock("@/lib/supabase/server", () => ({
      supabaseServer: async () => {
        throw new Error("`cookies` was called outside a request scope");
      },
    }));
    const { GET } = await import("../src/app/auth/callback/route");
    const r = await GET(new Request("https://caracal.test/auth/callback?code=abc"));
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("failed");
  });
});

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

async function renderSignIn(states: unknown[], auth: unknown) {
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
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve({ disconnect: async () => {} }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/signin/page");
  return { tree: mod.default(), effects, setters };
}

describe("r4c follow-up: the sign-in page while it checks", () => {
  it("shows a checking line and Sign out, not Continue with Google", async () => {
    const auth = { getUser: async () => new Promise(() => {}), getSession: async () => ({ data: { session: null } }), signOut: async () => ({ error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
    // state order in SignIn: error, signIn, busy
    const { tree } = await renderSignIn([null, null, false], auth);
    const all = texts(tree).join(" | ");
    expect(all).toMatch(/Checking your sign-in/);
    expect(all).not.toMatch(/Continue with Google/);
    expect(clickHandlerFor(tree, "Sign out")).not.toBeNull();
  });

  it("a check that ends after Sign out does not show the old account as signed in", async () => {
    let finish: (v: unknown) => void = () => {};
    const auth = {
      getUser: () => new Promise((r) => (finish = r)),
      getSession: async () => ({ data: { session: null } }),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    };
    const { tree, effects, setters } = await renderSignIn([null, null, false], auth);
    effects.forEach((f) => f());
    await clickHandlerFor(tree, "Sign out")!();
    expect(auth.signOut).toHaveBeenCalled();
    finish({ data: { user: { id: "A", email: "a@x.ng" } }, error: null });
    await new Promise((r) => setTimeout(r, 20));
    const signIn = setters.filter((s) => s.i === 1).map((s) => s.v as { kind: string });
    expect(signIn.at(-1)?.kind).toBe("signed-out");
  });
});

describe("r4c follow-up: the wallet page's account-changed label", () => {
  it("does not claim the change came from another tab", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/app/wallet/page.tsx", import.meta.url), "utf8"));
    const label = /const ACCOUNT_CHANGED = "([^"]*)"/.exec(src)?.[1];
    expect(label).toBeDefined();
    expect(label).not.toMatch(/another tab/);
  });
});

describe("r4c follow-up: CHANNELS_API_KEY checked locally", () => {
  function walletOnChain() {
    const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null });
    const data = new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(WALLET).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(inst),
    });
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [{ val: xdr.LedgerEntryData.contractData(data) }] })) as never);
  }
  function transfer() {
    const c = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
    const auth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(c), subInvocations: [] }),
    });
    return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(c).toXDR("base64"), auth: [auth.toXDR("base64")] };
  }
  it.each(["key-with-newline\n", "key with space", "kéy"])("%j: a 503 naming the setting, nothing sent", async (key) => {
    walletOnChain();
    vi.stubEnv("CHANNELS_API_KEY", key);
    const before = fakeChannels.requests.length;
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/CHANNELS_API_KEY/);
    expect(fakeChannels.requests.length).toBe(before);
  });
});

describe("r4d follow-up: what an upstream access_denied tells the person", () => {
  it("access_denied alone is a cancelled sign-in", async () => {
    const { upstreamErrorCode } = await import("../src/lib/auth/signin-errors");
    expect(upstreamErrorCode(new URLSearchParams("error=access_denied&error_description=user+cancelled"))).toBe("cancelled");
  });
  it.each(["signup_disabled", "user_banned"])("access_denied with error_code=%s is not called a cancellation", async (code) => {
    const { upstreamErrorCode } = await import("../src/lib/auth/signin-errors");
    expect(upstreamErrorCode(new URLSearchParams(`error=access_denied&error_code=${code}`))).toBe("failed");
  });
});
