// Codex Day 1 R8 (2026-11-28) regression tests:
// #1 one close ledger for the whole browser: an account's older attempt with no recorded bound could borrow
//    another account's later one, and escape once it passed. Now the close ledger is kept per account.
// #2 a possibleWallets write that storage refused still cleared the attempt's record (the only other place
//    the address was kept) and started a new wallet. Now the page stops and asks the person to keep it.
// #3 a bare Channels HTTP 429 was reported as "Nothing was sent". Now it is unknown: check your activity.
// #4 the header linked to Split, Invoices, Tax and Cash out, which this branch does not have (404).
import { afterEach, describe, expect, it, vi } from "vitest";
import { creationMarker, POSSIBLE_WALLETS_KEY } from "../src/lib/auth/creation-marker";
import { channelsClient, submitToChannels } from "../src/lib/relay/channels";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "next/navigation", "@/lib/supabase/client", "@/lib/stellar/kit"]) vi.doUnmock(m);
  vi.resetModules();
});

const PENDING = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const mapStore = (m: Map<string, string>, refuse: string[] = []) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuse.includes(k)) throw new Error("QuotaExceededError");
    m.set(k, v);
  },
  removeItem: (k: string) => void m.delete(k),
});

describe("Codex Day 1 R8 #1: an account's close ledger is its own", () => {
  it("another account's recorded close ledger is not this account's", () => {
    const m = new Map<string, string>([["caracal.creationUnconfirmed", "A"]]);
    const marker = creationMarker(mapStore(m));
    marker.recordCloseLedger("B", 1024);
    expect(marker.closeLedger("B")).toBe(1024);
    expect(marker.closeLedger("A")).toBeNull();
    // a second marker (a reload or another tab) reads the same from storage
    expect(creationMarker(mapStore(m)).closeLedger("A")).toBeNull();
    expect(creationMarker(mapStore(m)).closeLedger("B")).toBe(1024);
  });

  it("the older single-number form names no account", () => {
    const m = new Map<string, string>([["caracal.creationCloseLedger", "1024"]]);
    expect(creationMarker(mapStore(m)).closeLedger("A")).toBeNull();
  });

  it("clearing one account's attempt keeps the other's close ledger", () => {
    const m = new Map<string, string>([["caracal.creationUnconfirmed", "A,B"]]);
    const marker = creationMarker(mapStore(m));
    marker.recordCloseLedger("A", 1000);
    marker.recordCloseLedger("B", 2000);
    marker.markCreation("A", false);
    expect(creationMarker(mapStore(m)).closeLedger("A")).toBeNull();
    expect(creationMarker(mapStore(m)).closeLedger("B")).toBe(2000);
  });
});

// ---- the wallet page (the repo's React-state stub, as test/codex-r7.test.ts) ----
type El = { props?: { children?: unknown; onClick?: () => unknown; href?: string } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function clickOn(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickOn(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  if (typeof f === "function" && own.includes(text)) return f;
  return clickOn(kids, text);
}

async function walletPage(local: Map<string, string>, states: unknown[], kitExtra: Record<string, unknown>, refuse: string[] = []) {
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
  const user = { id: "A", email: "a@x.ng" };
  const auth = {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { user } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const kit = { events: { on: () => () => {} }, disconnect: async () => {}, connectWallet: async () => null, createWallet: vi.fn(async () => { throw new Error("The operation either timed out or was not allowed."); }), ...kitExtra };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: mapStore(local, refuse),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  const last = () => setters.filter((x) => x.i === 0).at(-1)?.v as { kind: string; message?: string; notFound?: string; unsaved?: boolean };
  return { tree: mod.default(), kit, last };
}
const ledgerRpc = (latest: number) => ({
  getLatestLedger: async () => ({ sequence: latest }),
  getLedgerEntries: async () => ({ entries: [], latestLedger: latest }),
});
const ME = { id: "A", email: "a@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Codex R8 #1 on the page: a later attempt of another account never bounds this account's", () => {
  it("A's unbounded attempt stays refused although B's close ledger has passed", async () => {
    const local = new Map<string, string>([
      ["caracal.creationUnconfirmed", "A,B"],
      ["caracal.creationStartedAt", String(Date.now() - 4 * 60_000)],
      ["caracal.creationCloseLedger", JSON.stringify({ B: 1024 })],
      ["caracal.creationPendingWallet", JSON.stringify({ A: PENDING })],
    ]);
    const p = await walletPage(local, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Ada", ME], { rpc: ledgerRpc(999_999) });
    await clickOn(p.tree, "Start a new one anyway")!();
    await settle();
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(p.last().message).toMatch(/last possible ledger was not recorded/);
    expect(local.get("caracal.creationUnconfirmed")).toBe("A,B");
  });
});

describe("Codex R8 #2: an address storage would not keep is never dropped", () => {
  const earlier = () =>
    new Map<string, string>([
      ["caracal.creationUnconfirmed", "A"],
      ["caracal.creationStartedAt", String(Date.now() - 4 * 60_000)],
      ["caracal.creationCloseLedger", JSON.stringify({ A: 1024 })],
      ["caracal.creationPendingWallet", JSON.stringify({ A: PENDING })],
    ]);
  const chose = { kind: "error", message: "x", checkFirst: true, notFound: PENDING };

  it("control: with storage that saves, the explicit choice keeps the address and creates", async () => {
    const local = earlier();
    const p = await walletPage(local, [chose, "Ada", ME], { rpc: ledgerRpc(1025), relayer: { url: "https://caracal.test/api/relay" } });
    await clickOn(p.tree, "Make a new wallet anyway (if the earlier one exists, you will have two)")!();
    await settle();
    expect(p.kit.createWallet).toHaveBeenCalledTimes(1);
    expect(JSON.parse(local.get(POSSIBLE_WALLETS_KEY)!)).toEqual({ A: [PENDING] });
  });

  it("when the save is refused, nothing is created, the record stays, and the address is shown to keep", async () => {
    const local = earlier();
    const p = await walletPage(local, [chose, "Ada", ME], { rpc: ledgerRpc(1025), relayer: { url: "https://caracal.test/api/relay" } }, [POSSIBLE_WALLETS_KEY]);
    await clickOn(p.tree, "Make a new wallet anyway (if the earlier one exists, you will have two)")!();
    await settle();
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(local.get("caracal.creationUnconfirmed")).toBe("A");
    expect(JSON.parse(local.get("caracal.creationPendingWallet")!)).toEqual({ A: PENDING });
    expect(p.last().unsaved).toBe(true);
    expect(p.last().message).toContain(PENDING);
    expect(p.last().message).toMatch(/could not save the earlier attempt's wallet address/);

    // the only way on is the person saying they kept it, for this address
    vi.resetModules();
    const shown = await walletPage(local, [p.last(), "Ada", ME], { rpc: ledgerRpc(1025) }, [POSSIBLE_WALLETS_KEY]);
    const words = texts(shown.tree).join(" ");
    expect(words).toContain("I have kept the address. Make a new wallet");
    expect(words).not.toContain("Make a new wallet anyway (if the earlier one exists, you will have two)");
  });

  it("once the person says they kept it, the new wallet starts", async () => {
    const local = earlier();
    const state = { kind: "error", message: "x", checkFirst: true, notFound: PENDING, unsaved: true };
    const p = await walletPage(local, [state, "Ada", ME], { rpc: ledgerRpc(1025), relayer: { url: "https://caracal.test/api/relay" } }, [POSSIBLE_WALLETS_KEY]);
    await clickOn(p.tree, "I have kept the address. Make a new wallet")!();
    await settle();
    expect(p.kit.createWallet).toHaveBeenCalledTimes(1);
  });

  it("a keep-confirmation for another address (the record changed since) does not start one", async () => {
    const local = earlier();
    const state = { kind: "error", message: "x", checkFirst: true, notFound: "CBOTHERWALLETNOTTHEPENDINGONE", unsaved: true };
    const p = await walletPage(local, [state, "Ada", ME], { rpc: ledgerRpc(1025) }, [POSSIBLE_WALLETS_KEY]);
    await clickOn(p.tree, "I have kept the address. Make a new wallet")!();
    await settle();
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(p.last().notFound).toBe(PENDING);
  });
});

describe("Codex R8 #3: a bare Channels 429 is an unknown outcome", () => {
  it("is not reported as nothing sent, and asks the person to check", async () => {
    fakeChannels.reply = (_req, res) => {
      // an empty body: the client raises PluginTransportError with statusCode 429 (channels-client.js parseAxiosError)
      res.writeHead(429);
      res.end();
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await submitToChannels(channelsClient("k-1", fakeChannels.url, 2000), "AAAA");
    expect(out.ok).toBe(false);
    const error = (out as { error: string }).error;
    expect(error).not.toContain("Nothing was sent");
    expect(error).toContain("Check your activity");
  });
});

describe("Codex R8 #4: the header links only to pages this branch has", () => {
  it("every header link is a route under src/app", async () => {
    vi.doMock("next/navigation", () => ({ usePathname: () => "/wallet" }));
    const { default: AppNav } = await import("../src/components/app-nav");
    const hrefs: string[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n !== "object" || n === null) return;
      const el = n as El;
      if (typeof el.props?.href === "string") hrefs.push(el.props.href);
      walk(el.props?.children);
    };
    walk(AppNav());
    expect(hrefs).toContain("/wallet");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const h of hrefs) expect(existsSync(join(__dirname, "../src/app", h, "page.tsx")), h).toBe(true);
  });
});
