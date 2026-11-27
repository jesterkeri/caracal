// Adversary r4h: a long name typed on /wallet makes the passkey step fail, and
// the page then says the wallet "may already exist" and hides Create.
//
// Spec: docs/decisions.md 2026-11-26 (r4g row): "Create is offered only where
// the page knows this account has no wallet yet: ... after a passkey prompt that
// failed (nothing sent) ... any other creation failure ... also says the wallet
// may already exist". Goals 3 (a wrong cause) and 4 (no way forward).
//
// Cause: apps/web/src/app/wallet/page.tsx passes the "Your name" input
// (no maxLength) as the kit's userName. smart-account-kit 0.10.0
// kit/webauthn-ops.js builds user.id = base64url(`${userName}:${Date.now()}:${Math.random()}`),
// so its decoded length is name + about 33 bytes. WebAuthn (create(), step 5)
// requires user.id to be 1 to 64 bytes, so the browser throws a TypeError, and
// @simplewebauthn/browser 13.3.0 (identifyRegistrationError) rethrows it as a
// WebAuthnError named "TypeError". PASSKEY_STEP_ERRORS in the page does not
// contain "TypeError", so create() treats it as a failure of unknown timing:
// the person is told "User ID was not between 1 and 64 characters", "Your wallet
// may already exist", and is offered only "I already have a wallet". Reloading
// and typing the same name fails the same way; nothing says the name is the cause.
//
// The page runs against the real app kit (src/lib/stellar/kit.ts), the real
// smart-account-kit and the real @simplewebauthn/browser. Only the browser's
// navigator.credentials.create is faked, and it enforces the WebAuthn rule above.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
});

const CREATE = "Create wallet with a passkey";
const CONNECT = "I already have a wallet";
const A = { id: "A", email: "a@x.ng" };

type El = { type?: unknown; props?: { children?: unknown; onClick?: () => unknown; maxLength?: number; placeholder?: string } };
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
function findInput(node: unknown): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findInput(n);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  if ((node as El).type === "input") return node as El;
  return findInput((node as El).props?.children);
}

type Wallet = { kind: string; message?: string; createAllowed?: boolean; checkFirst?: boolean };

/** What the browser's navigator.credentials.create does with the options: WebAuthn create() step 5. */
function fakeBrowser() {
  const created: { userIdBytes: number }[] = [];
  const rejected: { userIdBytes: number }[] = [];
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("location", { hostname: "caracal.test", origin: "https://caracal.test" });
  vi.stubGlobal("navigator", {
    locks: (globalThis.navigator as { locks?: unknown } | undefined)?.locks, // harness: a real browser has Web Locks (added for Codex R5 #1)
    credentials: {
      create: async (o: { publicKey: { user: { id: ArrayBuffer | Uint8Array } } }) => {
        const userIdBytes = o.publicKey.user.id.byteLength;
        if (userIdBytes < 1 || userIdBytes > 64) {
          rejected.push({ userIdBytes });
          const e = new TypeError("user.id is not between 1 and 64 bytes");
          throw e;
        }
        created.push({ userIdBytes });
        // The passkey was made. Anything the kit does with it after this is not
        // what this test is about, so stop here with a failure the page treats alike.
        throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
      },
    },
  });
  return { created, rejected };
}

async function renderWallet(states: unknown[]) {
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
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", hostname: "caracal.test", search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

/** Types `typed` into the name box (as the browser would cut it to maxLength), clicks Create, returns what is shown next. */
async function createWithName(typed: string) {
  const browser = fakeBrowser();
  const first = await renderWallet([{ kind: "idle" }, "", A]);
  const input = findInput(first.tree);
  expect(input, "the name input is on the page").not.toBeNull();
  const max = input!.props?.maxLength;
  const name = typeof max === "number" ? typed.slice(0, max) : typed;
  vi.resetModules();
  const { tree, setters } = await renderWallet([{ kind: "idle" }, name, A]);
  await clickHandlerFor(tree, CREATE)!();
  await settle();
  const state = setters.filter((s) => s.i === 0).map((s) => s.v as Wallet).at(-1)!;
  vi.resetModules();
  const { tree: after } = await renderWallet([state, name, A]);
  return { browser, state, shown: texts(after).join(" | "), name };
}

describe("adversary r4h: a long name typed on /wallet", () => {
  it("control: a short name reaches the browser's passkey prompt, and its prompt failing offers Create again", async () => {
    const { browser, state, shown } = await createWithName("Ada");
    expect(browser.rejected).toEqual([]);
    expect(browser.created).toHaveLength(1); // the harness drives the real kit up to navigator.credentials.create
    expect(state.kind).toBe("error");
    expect(state.createAllowed).toBe(true); // NotAllowedError: nothing was sent
    expect(shown).toContain(CREATE);
    expect(shown).not.toContain("may already exist");
  });

  it("a 36-character name does not end in 'Your wallet may already exist' with Create hidden", async () => {
    const { browser, state, shown, name } = await createWithName("Oluwaseun Adebayo Olanrewaju Johnson");
    // Fixed either by limiting the box (name is then cut short and reaches the prompt) or by naming the failure.
    if (browser.created.length === 1) return;
    expect(browser.rejected).toHaveLength(1);
    expect(state.kind).toBe("error");
    // Nothing was created or sent: the browser refused the passkey request itself.
    // Defect: the page claims a wallet may exist and offers only Connect.
    expect(shown, `name sent to the kit: ${JSON.stringify(name)}`).not.toContain("may already exist");
    expect(shown).toContain(CREATE);
    expect(shown).toContain(CONNECT);
  });
});
