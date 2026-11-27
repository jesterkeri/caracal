// Adversary r5e: "No wallet found? Start a new one anyway" is a dud, and blames
// another tab, for an account whose own wallet is still recorded on this browser.
//
// Spec: docs/decisions.md 2026-11-26 (r4j row, #47): after an unknown creation
// outcome "the page offers 'No wallet found? Start a new one anyway' for when
// Connect found nothing; it waits until the attempt is 3 minutes old". Row #59
// (2026-11-27, r5a): choosing a second wallet "is not refused because this
// account's own binding is still recorded (after Disconnect or an expired
// session)". Attacker goals 3 (a wrong cause) and 4 (a control offered that
// cannot work).
// Cause: apps/web/src/app/wallet/page.tsx createAnyway() calls create({ anyway:
// true }) with no `secondTo`, so createHoldingLock() computes chosenSecond =
// false; `recordedOwner === me.id && !chosenSecond` then refuses with
// WALLET_RECORDED_ELSEWHERE ("created or connected in another tab") although no
// other tab exists, and markCreation(me.id, false) has already cleared the
// account's "creation unconfirmed" note on the way. The path: the account has a
// wallet W1 (owner binding kept after Disconnect), the person chose "Make a
// second, new wallet instead", its outcome was unknown, and 3+ minutes later
// they press the escape the page offers.
// Rendered with React's state and effects stubbed, as adversary-r5c and r5d do;
// the person's clicks run the page's real handlers against one shared
// localStorage fake. Any fix that makes the escape work (for example passing the
// remembered wallet as `secondTo`) passes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_KEY, KNOWN_WALLETS_KEY } from "../src/lib/auth/wallet-binding";
import { CREATION_STARTED_AT_KEY, CREATION_UNCONFIRMED_KEY } from "../src/lib/auth/creation-marker";
import { withLedger } from "./fake-ledger";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function clickFor(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickFor(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  if (typeof f === "function" && own.includes(text)) return f;
  return clickFor(kids, text);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const A = { id: "A", email: "a@x.ng" };
// A valid contract strkey (the repo's WALLET fixture): this account's first wallet.
const W1 = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
type S = { kind: string; message?: string; createAllowed?: boolean; checkFirst?: boolean; remembered?: string; knownWallet?: boolean };

/** One browser: a localStorage that lives across re-renders, and a kit whose Create attempts are counted. */
function browser(local: Map<string, string>) {
  const createWallet = vi.fn(async (): Promise<unknown> => {
    // The person closes the passkey prompt: nothing is made, which is all this test needs to see that Create ran.
    throw new Error("The operation either timed out or was not allowed.");
  });
  const kit = {
    events: { on: () => () => {} },
    disconnect: async () => {},
    connectWallet: async (): Promise<unknown> => null,
    createWallet,
    // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
    rpc: { getLatestLedger: async () => ({ sequence: 1000 }) } as unknown,
  };
  async function render(state: S) {
    vi.resetModules();
    const setters: { i: number; v: unknown }[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      let i = 0;
      const init = [state, "Ada", A];
      return {
        ...actual,
        default: actual,
        useState: (v: unknown) => {
          const at = i++;
          return [at < init.length ? init[at] : v, (n: unknown) => setters.push({ i: at, v: n })];
        },
        useEffect: () => {},
      };
    });
    const auth = {
      getUser: async () => ({ data: { user: A }, error: null }),
      getSession: async () => ({ data: { session: { user: A } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    };
    vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
    vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(kit)) }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    vi.stubGlobal("window", {
      location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => void local.set(k, v),
        removeItem: (k: string) => void local.delete(k),
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("../src/app/wallet/page");
    return { tree: mod.default(), setters };
  }
  const last = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as S | undefined;
  return { render, last, createWallet };
}

/**
 * Account A has wallet W1 (remembered here; `bound` keeps its owner binding, as
 * it is after Disconnect or an expired session) and an earlier creation of a
 * second wallet whose outcome is unknown, started 4 minutes ago. The person
 * presses "Make a second, new wallet instead" (the page says an earlier attempt
 * could not be confirmed), then, since Connect finds nothing, the escape.
 */
async function pressEscape(bound: boolean) {
  const local = new Map<string, string>();
  if (bound) local.set(WALLET_OWNER_KEY, A.id);
  local.set(KNOWN_WALLETS_KEY, JSON.stringify({ [A.id]: W1 }));
  local.set(CREATION_UNCONFIRMED_KEY, A.id);
  local.set(CREATION_STARTED_AT_KEY, String(Date.now() - 4 * 60_000));
  local.set("caracal.creationCloseLedger", "999"); // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
  const b = browser(local);

  const first = await b.render({ kind: "idle", knownWallet: true, remembered: W1 });
  const second = clickFor(first.tree, "Make a second, new wallet instead");
  expect(second, "the page offers the explicit second-wallet choice").not.toBeNull();
  await second!();
  const afterSecond = b.last(first.setters);
  expect(afterSecond?.kind).toBe("error");
  expect(afterSecond?.checkFirst, "the page says an earlier attempt is unconfirmed and offers the escape").toBe(true);
  expect(b.createWallet).not.toHaveBeenCalled();

  const next = await b.render(afterSecond!);
  const escape = clickFor(next.tree, "Start a new one anyway");
  expect(escape, "the page offers the escape").not.toBeNull();
  await escape!();
  return { shown: b.last(next.setters), createWallet: b.createWallet, local };
}

describe("adversary r5e: the 'Start a new one anyway' escape for an account whose own wallet is recorded here", () => {
  it("control: with no owner binding recorded, the escape (4 minutes after the attempt) starts a creation", async () => {
    const r = await pressEscape(false);
    expect(r.createWallet).toHaveBeenCalledTimes(1);
  });

  it("with this account's own wallet recorded (after Disconnect), the escape starts a creation instead of blaming another tab", async () => {
    const r = await pressEscape(true);
    // Defect: refused with "created or connected in another tab"; no other tab exists.
    expect(r.shown?.message ?? "", "the page blamed another tab").not.toMatch(/another tab/);
    expect(r.createWallet, "the escape the page offered did nothing").toHaveBeenCalledTimes(1);
  });
});
