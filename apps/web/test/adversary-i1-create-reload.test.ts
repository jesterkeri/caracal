// Adversary i1: a wallet creation started on the pay page is forgotten by a reload.
//
// Goal 5 (a wallet created on the pay page in a way the wallet page's own creation
// guarantees forbid: "a second unknowingly"). docs/decisions.md 2026-11-26: "Just
// before a creation is sent, the page records `caracal.creationUnconfirmed` ... in
// localStorage ... While it is set ..., a reload offers only Connect with 'Your
// wallet may already exist'". The wallet page does this (creation-marker.ts). The
// pay page says "Your wallet may have been created ... before creating another"
// and hides Create, but only in React state (createOpen): nothing is recorded, so
// reloading the pay link, or opening it again, offers "Create a wallet" again and
// a second passkey and wallet can follow an attempt whose outcome was never known.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function walk(node: unknown, f: (el: El) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, f));
  if (typeof node !== "object" || node === null) return;
  f(node as El);
  walk((node as El).props?.children, f);
}
function click(node: unknown, text: string): () => unknown {
  let found: (() => unknown) | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el.props.onClick;
  });
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.resetModules();
});

// One browser: its localStorage outlives a page load.
const storage = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

const open = { kind: "invoice", invoice: { amount: BigInt(1_500_000_000), status: "open" }, txHash: null };

/** Renders the pay client for a fresh page load: state starts empty (view is already the open invoice). */
async function render(kit: unknown, initial: Record<number, unknown> = {}) {
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        const v = at in initial ? initial[at] : typeof init === "function" ? (init as () => unknown)() : init;
        return [v, (x: unknown) => setters.push({ i: at, v: x })];
      },
      useEffect: () => undefined,
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: USDC }) };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => kit }));
  vi.stubGlobal("window", { localStorage });
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), setters };
}
// state order in pay-client.tsx: view, wallet, pay, name, createOpen
const VIEW = 0;
const PAY = 2;
const CREATE_OPEN = 4;
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A kit whose passkey is made and whose wallet then fails to confirm: the outcome is unknown. */
const kitFailingAfterPasskey = () => {
  let onCreated: (() => void) | undefined;
  return {
    events: { on: (_e: string, cb: () => void) => ((onCreated = cb), () => undefined) },
    createWallet: async () => {
      onCreated?.();
      throw new Error("Relayer request failed with status 504");
    },
  };
};

describe("a creation whose outcome is unknown is remembered across a reload", () => {
  // Changed after the fix (disclosed in docs/decisions.md): the pay page no
  // longer creates wallets at all. It links to the wallet page, which keeps the
  // creation marker, so the original two tests (which clicked the pay page's
  // own "Create a wallet") now check that no creation can start here.
  it("control: the pay page offers Connect and sends a new payer to the wallet page", async () => {
    storage.clear();
    const page = await render(kitFailingAfterPasskey(), { [VIEW]: open });
    expect(texts(page.tree)).toContain("Use my existing wallet");
    const links: string[] = [];
    walk(page.tree, (el) => {
      const href = (el.props as { href?: unknown } | undefined)?.href;
      if (typeof href === "string") links.push(href);
    });
    expect(links).toContain("/wallet");
  });

  it("no wallet creation can start on the pay page, so none is forgotten by a reload", async () => {
    storage.clear();
    const kit = { ...kitFailingAfterPasskey(), createWallet: vi.fn(async () => undefined) };
    const page = await render(kit, { [VIEW]: open });
    expect(texts(page.tree)).not.toContain("Create a wallet");
    walk(page.tree, (el) => {
      if (typeof el.props?.onClick === "function" && !texts(el.props.children).includes("Use my existing wallet")) void el.props.onClick();
    });
    await settle();
    expect(kit.createWallet).not.toHaveBeenCalled();
    vi.resetModules();
    const reloaded = await render(kitFailingAfterPasskey(), { [VIEW]: open });
    expect(texts(reloaded.tree)).not.toContain("Create a wallet");
  });

  it("a creation the wallet page left unconfirmed in this browser is not ignored by the pay page", async () => {
    storage.clear();
    // What the wallet page writes just before it sends a creation (creation-marker.ts).
    storage.set("caracal.creationUnconfirmed", "5c1f0d52-6c0e-4b57-9a4f-0c5d3a6f1b11");
    storage.set("caracal.creationStartedAt", String(Date.now()));
    const page = await render(kitFailingAfterPasskey(), { [VIEW]: open });
    expect(texts(page.tree)).not.toContain("Create a wallet");
  });
});
