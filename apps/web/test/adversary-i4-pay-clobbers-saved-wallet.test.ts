// Adversary i4. Promise (apps/web/src/lib/auth/wallet-binding.ts header; docs/decisions.md 2026-11-26 r3g and
// r4i rows; invoices/page.tsx comment "Only a wallet this account connected on this browser is used"): the
// saved passkey wallet session belongs to the account that created or connected it, and a page restores it
// only for that account. The invoices page opens and cancels invoices on the split of whatever wallet the kit
// restores, and files the client's name in the signed-in account's rows.
//
// The pay page's Connect (pay-client.tsx, connect()) calls kit.connectWallet({ fresh: true }). The real kit
// (node_modules/smart-account-kit/dist/kit/wallet-ops.js, end of connectWithCredentials) does
// storage.saveSession({ contractId, credentialId, ... }) for every wallet it connects, so the PAYER's wallet
// replaces the saved session in the browser's IndexedDB. The pay page does not touch caracal.walletOwner or
// caracal.knownWallets, so the binding still says "account A", and the invoices page (and the wallet page)
// then restore the payer's wallet as account A's.
// A freelancer who tests their own pay link with a second wallet in the same browser, which is journey 4 of
// docs/fix-day.md ("Pay the invoice from a second account"), hits this.
//
// Real: smart-account-kit 0.10.0's SmartAccountKit.connectWallet (session handling, fresh) and MemoryStorage;
// the real getKit, wallet-binding, pay-client and invoices page code. Stand-ins: React state (as in
// pay-page.test.ts), the WebAuthn prompt (config.webAuthn), the chain reads, and the kit's
// connectWithCredentials, whose network and proof checks cannot run offline: the stand-in keeps only what that
// function does on success (wallet-ops.js: storage.save, setConnectedState, storage.saveSession).
import { MemoryStorage } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const A = "account-a";
const FREELANCER_WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER_WALLET = TOKENS.xlm; // any other valid C address
const CRED_FREELANCER = "AQIDBAUGBwg";
const CRED_PAYER = "CQoLDA0ODxA";
const REF = "0123456789abcdef0123456789abcdef";
const FREELANCER_SPLIT = splitAddressFor(FREELANCER_WALLET);
const PAYER_SPLIT = splitAddressFor(PAYER_WALLET);
const WALLET_OF: Record<string, string> = { [CRED_FREELANCER]: FREELANCER_WALLET, [CRED_PAYER]: PAYER_WALLET };

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function click(node: unknown, text: string): () => unknown {
  let found: (() => unknown) | null = null;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object" || n === null) return;
    const el = n as El;
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el.props.onClick;
    walk(el.props?.children);
  };
  walk(node);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "smart-account-kit", "@/lib/supabase/client", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows"]) vi.doUnmock(m);
  vi.resetModules();
});

/** One browser: IndexedDB (the kit's saved session) and localStorage (the account binding) outlive every page load. */
function browser() {
  const sharedKitStorage = new MemoryStorage();
  void sharedKitStorage.saveSession({ contractId: FREELANCER_WALLET, credentialId: CRED_FREELANCER, connectedAt: Date.now(), expiresAt: Date.now() + 3 * 24 * 3600_000 });
  const local = new Map<string, string>([
    ["caracal.walletOwner", A],
    ["caracal.knownWallets", JSON.stringify({ [A]: FREELANCER_WALLET })],
  ]);
  const win = {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", hostname: "caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  };
  return { sharedKitStorage, local, win };
}

/** A fresh page load: new module registry, new React stub, new kit instance, same browser storage. */
async function load<T>(b: ReturnType<typeof browser>, page: "invoices" | "pay", states: unknown[]) {
  vi.resetModules();
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
  vi.doMock("smart-account-kit", async () => {
    const actual = await vi.importActual<typeof import("smart-account-kit")>("smart-account-kit");
    class SharedStorage extends actual.MemoryStorage {
      constructor() {
        super();
        return b.sharedKitStorage as unknown as SharedStorage;
      }
    }
    // Type-only (2026-11-27): the stand-in overrides the kit's private connectWithCredentials on purpose.
    // @ts-expect-error -- a private member is overridden for the test
    class TestKit extends actual.SmartAccountKit {
      constructor(cfg: ConstructorParameters<typeof actual.SmartAccountKit>[0]) {
        // The person picks the payer's passkey when the browser asks.
        super({ ...cfg, webAuthn: { startRegistration: async () => Promise.reject(new Error("not used")), startAuthentication: async () => ({ id: CRED_PAYER }) } as never });
      }
      // Stand-in for the verification step; keeps what the real one does on success.
      async connectWithCredentials(credentialId?: string, contractId?: string) {
        const wallet = contractId ?? WALLET_OF[credentialId!]!;
        const k = this as unknown as { storage: MemoryStorage; setConnectedState(c: string, cr: string): void };
        k.setConnectedState(wallet, credentialId!);
        const now = Date.now();
        await k.storage.saveSession({ contractId: wallet, credentialId: credentialId!, connectedAt: now, expiresAt: now + 7 * 24 * 3600_000 });
        return { credentialId: credentialId!, contractId: wallet } as never;
      }
    }
    return { ...actual, IndexedDBStorage: SharedStorage, SmartAccountKit: TestKit };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      // Both wallets own a split on chain.
      readConfig: async (_s: unknown, split: string) => (split === FREELANCER_SPLIT ? { owner: FREELANCER_WALLET, token: TOKENS.usdc } : split === PAYER_SPLIT ? { owner: PAYER_WALLET, token: TOKENS.usdc } : null),
      readInvoice: async () => ({ amount: BigInt(10_000_000), status: "open" }),
      findPaymentTx: async () => null,
    };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [] }));
  const auth = {
    getUser: async () => ({ data: { user: { id: A, email: "a@x.ng" } }, error: null }),
    getSession: async () => ({ data: { session: { user: { id: A } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "https://rpc.test.invalid");
  vi.stubGlobal("window", b.win);
  vi.stubGlobal("location", b.win.location);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = page === "invoices" ? await import("../src/app/invoices/page") : await import("../src/app/pay/[split]/[ref]/pay-client");
  const tree = page === "invoices" ? (mod as { default: () => unknown }).default() : (mod as { default: (p: { split: string; invoiceRef: string }) => unknown }).default({ split: FREELANCER_SPLIT, invoiceRef: REF });
  return { tree: tree as T, effects, setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

describe("a payer's Connect on the pay page and the saved wallet of the signed-in freelancer", () => {
  it("control: before any pay page, the invoices page restores the freelancer's own wallet for account A", async () => {
    const b = browser();
    const inv = await load(b, "invoices", [{ kind: "loading" }]);
    await inv.effects[0]!();
    await settle();
    expect(last(inv.setters, 0)).toMatchObject({ kind: "ready", account: A, wallet: FREELANCER_WALLET, split: FREELANCER_SPLIT });
  });

  it("control: the pay page's Connect really connects the payer's wallet (the passkey the browser returned)", async () => {
    const b = browser();
    const pay = await load(b, "pay", [{ kind: "invoice", invoice: { amount: BigInt(10_000_000), status: "open" }, txHash: null }]);
    await click(pay.tree, "Use my existing wallet")();
    await settle();
    expect(last(pay.setters, 1)).toBe(PAYER_WALLET);
  });

  it("after the freelancer pays a link with another wallet in the same browser, the invoices page does not act for the payer's wallet on account A", async () => {
    const b = browser();
    // 1. The pay page, same browser: the payer's passkey is chosen.
    const pay = await load(b, "pay", [{ kind: "invoice", invoice: { amount: BigInt(10_000_000), status: "open" }, txHash: null }]);
    await click(pay.tree, "Use my existing wallet")();
    await settle();
    expect(last(pay.setters, 1)).toBe(PAYER_WALLET);
    // The binding of the browser to account A was not changed by the pay page.
    expect(b.local.get("caracal.walletOwner")).toBe(A);
    expect(JSON.parse(b.local.get("caracal.knownWallets")!)).toEqual({ [A]: FREELANCER_WALLET });

    // 2. Later, the freelancer opens /invoices (a new page load, same browser storage), still signed in as A.
    const inv = await load(b, "invoices", [{ kind: "loading" }]);
    await inv.effects[0]!();
    await settle();
    const state = last(inv.setters, 0);
    // Account A's page must never open or cancel invoices from a wallet A did not connect: the payer's wallet and
    // its split must not appear. (It is "ready" for the payer's wallet, offering to open invoices on its split.)
    expect(show(state), show(state)).not.toContain(PAYER_WALLET);
    expect(show(state), show(state)).not.toContain(PAYER_SPLIT);
  });
});
