// Adversary c1: the real cash-out page (src/app/cashout/page.tsx) run through a small
// working React hook runtime (useState re-renders, useEffect with deps and cleanup), so
// its real state machine runs: boot, preview, start, form, confirm, send, watching.
// Faked: the anchor (a fetch stub serving the repo's real fixtures), the kit, Supabase,
// the popup. Not faked: the page, src/lib/anchor/*, the polling loop.
import { readFileSync } from "node:fs";
import { Address, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeEntries } from "../src/lib/anchor/sep45";
import { TEST_SIGNING_KEY, signAsAnchor, withTestKey } from "./sep45-test-anchor";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/anchor/${n}`, import.meta.url), "utf8");
const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
const SIGNING_KEY = TEST_SIGNING_KEY; // Codex cash-out R1 #2: challenges are signed (sep45-test-anchor.ts)
const CONTRACT = "CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX";
const FORM_URL = "https://anchor-ref-ui-testanchor.stellar.org?transaction_id=2ea23fcd&token=short";
const FORM_HREF = new URL(FORM_URL).toString(); // what the page opens (checkInteractiveUrl normalises it)
const ID = "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef";

function challenge(): string {
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
function runtime(component: () => unknown) {
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
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (el.props?.href) out.push(`href:${el.props.href}`);
    texts(el.props?.children, out);
  }
  return out;
}
function find(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, pred, out));
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (pred(el)) out.push(el);
    find(el.props?.children, pred, out);
  }
  return out;
}
const label = (el: El) => texts(el.props?.children).join("");
const buttons = (tree: unknown) => find(tree, (e) => e.type === "button" && typeof e.props?.onClick === "function");
const buttonLabels = (tree: unknown) => buttons(tree).map(label);
const clickButton = (tree: unknown, re: RegExp) => {
  const b = buttons(tree).find((e) => re.test(label(e)) && !e.props?.disabled);
  if (!b) throw new Error(`no enabled button matching ${re}: ${buttonLabels(tree).join(" | ")}`);
  return b.props!.onClick!();
};

// ---- the fakes --------------------------------------------------------------
type World = {
  txn: Record<string, unknown>;
  fetchLog: string[];
  hang: (url: string) => boolean;
  popup: { closed: boolean; close: () => void; location: { href: string } };
  opened: number;
  kit: { signAndSubmit: ReturnType<typeof vi.fn>; readBalance: ReturnType<typeof vi.fn> };
};

async function mount(over: { txn?: Record<string, unknown>; hang?: (url: string) => boolean; submit?: () => unknown } = {}) {
  const base = JSON.parse(fixture("txn-pending-user-transfer-start.json")) as { transaction: Record<string, unknown> };
  const world: World = {
    txn: { ...base.transaction, id: ID, status: "incomplete", ...over.txn },
    fetchLog: [],
    hang: over.hang ?? (() => false),
    popup: { closed: false, close() { this.closed = true; }, location: { href: "" } },
    opened: 0,
    kit: { signAndSubmit: vi.fn(over.submit ?? (async () => ({ success: true, hash: "cb".repeat(32) }))), readBalance: vi.fn(async () => BigInt(90_000_000)) },
  };
  const store = new Map([["caracal.walletOwner", "user-1"]]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "http://localhost:3000" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    open: () => {
      world.opened++;
      return world.popup;
    },
  });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      world.fetchLog.push(`${init?.method ?? "GET"} ${u}`);
      if (world.hang(u)) return new Promise<Response>(() => {});
      if (u.endsWith("/.well-known/stellar.toml")) return new Response(withTestKey(fixture("stellar.toml")));
      if (u.endsWith("/sep24/info")) return new Response(fixture("sep24-info.json"));
      if (u.includes("/sep45/auth") && init?.method === "POST") return new Response(JSON.stringify({ token: "TOK" }));
      if (u.includes("/sep45/auth")) return new Response(JSON.stringify({ authorization_entries: challenge() }));
      if (u.includes("/withdraw/interactive")) return new Response(JSON.stringify({ id: ID, url: FORM_URL }));
      if (u.includes("/sep24/transaction?")) return new Response(JSON.stringify({ transaction: world.txn }));
      return new Response("not found", { status: 404 });
    }),
  );
  const kit = {
    connectWallet: async () => ({ contractId: WALLET }),
    disconnect: async () => {},
    signAuthEntry: async (e: unknown) => e,
    signAndSubmit: world.kit.signAndSubmit,
    rpc: { getLatestLedger: async () => ({ sequence: 100 }) },
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
    return { ...actual, readUsdcBalance: balanceAtLedger(world.kit.readBalance), buildAnchorTransfer: async () => ({ assembled: true }) };
  });
  const mod = await import("../src/app/cashout/page");
  rt = runtime(mod.default as () => unknown);
  rt.start();
  return { rt, world };
}

const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};
const text = (rt: { tree: unknown }) => texts(rt.tree).join(" ").replace(/\s+/g, " ");

/** Types 2 USDC, presses Continue, and lets the anchor's form "finish" so the page reaches confirm. */
async function toConfirm(rt: ReturnType<typeof runtime>, world: World) {
  await tick(50);
  const input = find(rt.tree, (e) => e.type === "input")[0]!;
  input.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  void clickButton(rt.tree, /Continue to the anchor/);
  await tick(50);
  expect(text(rt)).toContain("Finish the anchor's form");
  world.txn.status = "pending_user_transfer_start";
  await tick(3100);
  expect(text(rt)).toContain("The anchor wants");
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/anchor/transfer");
  vi.resetModules();
});

describe("adversary c1: the cash-out page, end to end with a working hook runtime", () => {
  it("control: the happy path reaches confirm, sends once, and shows the anchor's completion", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(buttonLabels(rt.tree)).toContain("Send 2 USDC to the anchor");
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(text(rt)).toContain("was confirmed on Stellar, and the anchor has not recorded it yet"); // c20: a confirmed payment is not one the anchor still waits for
    world.txn.status = "completed";
    await tick(3100);
    expect(text(rt)).toMatch(/marked the withdrawal complete/);
    rt.unmount();
  });

  it("after the anchor's form is closed by mistake, the page offers a way to open it again", async () => {
    const { rt, world } = await mount();
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(50);
    expect(world.popup.location.href).toBe(FORM_HREF); // the popup was pointed at the form
    world.popup.closed = true; // the person closes it before finishing the form
    await tick(3100); // the page keeps polling: the anchor still says incomplete
    const t = text(rt);
    expect(t).toContain("Finish the anchor's form in the pop-up window");
    const opensForm = t.includes(`href:${FORM_HREF}`) || buttonLabels(rt.tree).some((l) => /open|reopen/i.test(l));
    expect(opensForm).toBe(true);
    rt.unmount();
  });

  it("the anchor's form changed the amount: the page says 'Start again', so it must offer a way to start again", async () => {
    const { rt, world } = await mount();
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(50);
    world.txn.status = "pending_user_transfer_start";
    world.txn.amount_in = "5"; // edited in the anchor's popup (docs/research/anchor-spike-2026-11-27.md section 5)
    await tick(3100);
    // Changed with adversary c12 (decisions row "Adversary c12"): this test first required an enabled
    // "Send 5 USDC to the anchor" and clicked it to reach the refusal. c12 proved that offering a Send the
    // page always refuses is itself a defect (as c8 for another asset), so the refusal's reason is now shown
    // without it. What this test guards is unchanged: nothing is sent, the reason, and a way to start again.
    expect(buttonLabels(rt.tree).filter((l) => /^Send/.test(l))).toEqual([]);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled(); // refused, correctly
    const t = text(rt);
    expect(t).toMatch(/Start again and keep the amount the same/);
    expect(buttonLabels(rt.tree).some((l) => /start|cancel|back/i.test(l))).toBe(true);
    rt.unmount();
  });

  it("an anchor that never answers the sign-in does not leave the page on 'Signing in...' for ever", async () => {
    const { rt } = await mount({ hang: (u) => u.includes("/sep45/auth") });
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(10 * 60_000); // ten minutes
    expect(text(rt)).not.toContain("Signing in to the anchor with your passkey");
    rt.unmount();
  });

  it("after a withdrawal completes, the wallet balance on the page is read again (it still said 9 USDC after 2 left)", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    world.txn.status = "completed";
    world.kit.readBalance.mockResolvedValue(BigInt(70_000_000)); // the chain now holds 7
    await tick(3100);
    expect(text(rt)).toMatch(/marked the withdrawal complete/);
    expect(text(rt)).not.toContain("USDC in the wallet: 9 USDC");
    rt.unmount();
  });
});

// Fixture changed with the port of Codex split R4 #2 (disclosed in docs/decisions.md): the real readUsdcBalance
// reports the ledger its simulation ran at; the fake reports the fake network's ledger at the moment of the read.
function balanceAtLedger(read: (...a: unknown[]) => Promise<unknown>) {
  return async (wallet: unknown, rpc: { getLatestLedger?: () => Promise<{ sequence: number }> }, at?: (l: number) => void) => {
    const b = await read(wallet, rpc);
    if (b !== null && at && rpc && typeof rpc.getLatestLedger === "function") {
      try {
        at((await rpc.getLatestLedger()).sequence);
      } catch {
        /* no ledger to report */
      }
    }
    return b;
  };
}
