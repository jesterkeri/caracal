// Shared harness for the adversary c2 tests: the real cash-out page (src/app/cashout/page.tsx)
// run through a small working React hook runtime (useState re-renders, useEffect with deps and
// cleanup), with the anchor (a fetch stub serving the repo's real fixtures), the kit, Supabase
// and the popup faked. Copied from adversary-c1-page.test.ts and extended with options (a custom
// rpc, the real buildAnchorTransfer, a browser-like popup, a status endpoint that can refuse).
import { readFileSync } from "node:fs";
import { Address, xdr } from "@stellar/stellar-sdk";
import { vi } from "vitest";
import { encodeEntries } from "../src/lib/anchor/sep45";
import { TEST_SIGNING_KEY, signAsAnchor, withTestKey } from "./sep45-test-anchor";

export const fixture = (n: string) => readFileSync(new URL(`./fixtures/anchor/${n}`, import.meta.url), "utf8");
export const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
export const SIGNING_KEY = TEST_SIGNING_KEY; // Codex cash-out R1 #2: challenges are signed (sep45-test-anchor.ts)
export const CONTRACT = "CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX";
export const FORM_URL = "https://anchor-ref-ui-testanchor.stellar.org?transaction_id=2ea23fcd&token=short";
export const FORM_HREF = new URL(FORM_URL).toString(); // what the page opens (checkInteractiveUrl normalises it)
export const ID = "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef";

export function challenge(): string {
  const arg = xdr.ScVal.scvMap(
    [
      ["account", WALLET],
      ["home_domain", "testanchor.stellar.org"],
      ["nonce", "n"],
      ["web_auth_domain", "testanchor.stellar.org"],
      ["web_auth_domain_account", SIGNING_KEY],
    ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k!), val: xdr.ScVal.scvString(v!) })),
  );
  const mk = (signer: string) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("5"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: Address.fromString(CONTRACT).toScAddress(), functionName: "web_auth_verify", args: [arg] }),
        ),
        subInvocations: [],
      }),
    });
  return encodeEntries([mk(WALLET), signAsAnchor(mk(SIGNING_KEY))]);
}

// ---- a working hook runtime -------------------------------------------------
type Slot = { v: unknown } | { deps?: unknown[]; cleanup?: () => void };
export function runtime(component: () => unknown) {
  const slots: Slot[] = [];
  let cursor = 0;
  let tree: unknown = null;
  let pending = false;
  let unmounted = false;
  const effects: { at: number; fn: () => unknown }[] = [];
  const render = () => {
    pending = false;
    cursor = 0;
    tree = component();
    for (const e of effects.splice(0)) {
      const s = slots[e.at] as { deps?: unknown[]; cleanup?: () => void };
      s.cleanup?.();
      const out = e.fn();
      s.cleanup = typeof out === "function" ? (out as () => void) : undefined;
    }
  };
  const schedule = () => {
    if (pending || unmounted) return;
    pending = true;
    queueMicrotask(() => !unmounted && render());
  };
  const hooks = {
    useState: (init: unknown) => {
      const at = cursor++;
      if (!slots[at]) slots[at] = { v: typeof init === "function" ? (init as () => unknown)() : init };
      const s = slots[at] as { v: unknown };
      return [
        s.v,
        (n: unknown) => {
          const next = typeof n === "function" ? (n as (p: unknown) => unknown)(s.v) : n;
          if (!Object.is(next, s.v)) {
            s.v = next;
            schedule();
          }
        },
      ];
    },
    useRef: (init: unknown) => {
      const at = cursor++;
      if (!slots[at]) slots[at] = { v: { current: init } };
      return (slots[at] as { v: unknown }).v;
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const at = cursor++;
      const prev = slots[at] as { deps?: unknown[] } | undefined;
      if (!prev) slots[at] = { deps };
      const changed = !prev || !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (changed) {
        (slots[at] as { deps?: unknown[] }).deps = deps;
        effects.push({ at, fn });
      }
    },
  };
  return {
    hooks,
    start: render,
    get tree() {
      return tree;
    },
    unmount: () => {
      unmounted = true;
      for (const s of slots) (s as { cleanup?: () => void }).cleanup?.();
    },
  };
}

type El = { type?: unknown; props?: { children?: unknown; href?: string; onClick?: () => unknown; onChange?: (e: unknown) => void; disabled?: boolean } };
export function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (el.props?.href) out.push(`href:${el.props.href}`);
    texts(el.props?.children, out);
  }
  return out;
}
export function find(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, pred, out));
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (pred(el)) out.push(el);
    find(el.props?.children, pred, out);
  }
  return out;
}
export const label = (el: El) => texts(el.props?.children).join("");
export const buttons = (tree: unknown) => find(tree, (e) => e.type === "button" && typeof e.props?.onClick === "function");
export const buttonLabels = (tree: unknown) => buttons(tree).map(label);
export const clickButton = (tree: unknown, re: RegExp) => {
  const b = buttons(tree).find((e) => re.test(label(e)) && !e.props?.disabled);
  if (!b) throw new Error(`no enabled button matching ${re}: ${buttonLabels(tree).join(" | ")}`);
  return b.props!.onClick!();
};

// ---- the fakes --------------------------------------------------------------
export type World = {
  txn: Record<string, unknown>;
  fetchLog: string[];
  hang: (url: string) => boolean;
  popup: { closed: boolean; close: () => void; location: { href: string }; opener?: unknown };
  opened: number;
  openArgs: unknown[][];
  kit: { signAndSubmit: ReturnType<typeof vi.fn>; readBalance: ReturnType<typeof vi.fn> };
};

export type MountOptions = {
  txn?: Record<string, unknown>;
  hang?: (url: string) => boolean;
  submit?: () => unknown;
  /** The kit's rpc. Default: answers getLatestLedger at once. */
  rpc?: unknown;
  /** Use the real buildAnchorTransfer (against `rpc`) instead of a stub. */
  realBuild?: boolean;
  popup?: World["popup"];
  /** HTTP status of the anchor's GET /transaction (default 200). */
  txnStatusCode?: () => number;
  /** The signAuthEntry the kit fake offers. */
  signAuthEntry?: (e: unknown) => Promise<unknown>;
  /** The browser's localStorage, to share it between two page loads (Codex cash-out R1 #1: a reload). */
  store?: Map<string, string>;
};

const realFetch = globalThis.fetch;

export async function mount(over: MountOptions = {}) {
  const mountedAt = Date.now();
  const base = JSON.parse(fixture("txn-pending-user-transfer-start.json")) as { transaction: Record<string, unknown> };
  const world: World = {
    txn: { ...base.transaction, id: ID, status: "incomplete", ...over.txn },
    fetchLog: [],
    hang: over.hang ?? (() => false),
    popup: over.popup ?? {
      closed: false,
      close() {
        this.closed = true;
      },
      location: { href: "" },
    },
    opened: 0,
    openArgs: [],
    kit: { signAndSubmit: vi.fn(over.submit ?? (async () => ({ success: true, hash: "cb".repeat(32) }))), readBalance: vi.fn(async () => BigInt(90_000_000)) },
  };
  const store = over.store ?? new Map<string, string>();
  store.set("caracal.walletOwner", "user-1");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "http://localhost:3000" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    open: (...args: unknown[]) => {
      world.opened++;
      world.openArgs.push(args);
      return world.popup;
    },
  });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1")) return realFetch(url, init); // a local test server, not the anchor
      world.fetchLog.push(`${init?.method ?? "GET"} ${u}`);
      if (world.hang(u)) return new Promise<Response>(() => {});
      if (u.endsWith("/.well-known/stellar.toml")) return new Response(withTestKey(fixture("stellar.toml")));
      if (u.endsWith("/sep24/info")) return new Response(fixture("sep24-info.json"));
      if (u.includes("/sep45/auth") && init?.method === "POST") return new Response(JSON.stringify({ token: "TOK" }));
      if (u.includes("/sep45/auth")) return new Response(JSON.stringify({ authorization_entries: challenge() }));
      if (u.includes("/withdraw/interactive")) return new Response(JSON.stringify({ id: ID, url: FORM_URL }));
      if (u.includes("/sep24/transaction?")) {
        const code = over.txnStatusCode?.() ?? 200;
        return new Response(code === 200 ? JSON.stringify({ transaction: world.txn }) : "denied", { status: code });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const kit = {
    connectWallet: async () => ({ contractId: WALLET }),
    disconnect: async () => {},
    signAuthEntry: over.signAuthEntry ?? (async (e: unknown) => e),
    signAndSubmit: world.kit.signAndSubmit,
    // A ledger every 5 s of the (fake) clock from ledger 100, as testnet closes them: a payment's closeBy passes as
    // time goes on (send-guard.ts). Fixture changed with the ledger-bound send guard; before, it stayed at 100.
    rpc: over.rpc ?? { getLatestLedger: async () => ({ sequence: 100 + Math.floor((Date.now() - mountedAt) / 5_000) }) },
  };
  const auth = {
    getUser: async () => ({ data: { user: { id: "user-1", email: "a@x.ng" } }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  let rt!: ReturnType<typeof runtime>;
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return { ...actual, default: actual, useState: (i: unknown) => rt.hooks.useState(i), useRef: (i: unknown) => rt.hooks.useRef(i), useEffect: (f: () => unknown, d?: unknown[]) => rt.hooks.useEffect(f, d) };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => kit }));
  vi.doMock("@/lib/anchor/transfer", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/anchor/transfer")>("../src/lib/anchor/transfer");
    return { ...actual, readUsdcBalance: world.kit.readBalance, buildAnchorTransfer: over.realBuild ? actual.buildAnchorTransfer : async () => ({ assembled: true }) };
  });
  const mod = await import("../src/app/cashout/page");
  rt = runtime(mod.default as () => unknown);
  rt.start();
  return { rt, world };
}

export const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};
export const text = (rt: { tree: unknown }) => texts(rt.tree).join(" ").replace(/\s+/g, " ");

/** Types 2 USDC and presses Continue; the page is then waiting in its sign-in or on the anchor's form. */
export async function pressContinue(rt: ReturnType<typeof runtime>) {
  await tick(50);
  find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  void clickButton(rt.tree, /Continue to the anchor/);
}

/** Continue, then the anchor's form "finishes" so the page reaches the confirm screen. */
export async function toConfirm(rt: ReturnType<typeof runtime>, world: World) {
  await pressContinue(rt);
  await tick(50);
  world.txn.status = "pending_user_transfer_start";
  await tick(3100);
}

export function unmock() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/anchor/transfer");
  vi.resetModules();
}
