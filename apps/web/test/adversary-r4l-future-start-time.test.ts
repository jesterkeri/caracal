// Adversary r4l: "Start a new one anyway" can stay blocked for hours when the
// browser's clock stepped back after the attempt was recorded.
//
// Spec: docs/decisions.md 2026-11-26 (r4j row): "it waits until the attempt is
// 3 minutes old (`caracal.creationStartedAt`)"; (r4k row): "a marker with no
// start time records one and waits the full time". Goal 4: a state the person
// cannot leave. The same repo already treats a backwards clock step as a fault
// to recover from (WindowLimiter.take: "a window also ends if the clock stepped
// back past its start").
// Cause: apps/web/src/app/wallet/page.tsx creationAge() returns
// Date.now() - startedAt, which is negative when startedAt is in the future, so
// `creationAge() < CREATION_SETTLE_MS` holds until the clock catches up with
// the stored stamp (here one hour, and the stamp is never re-recorded).
// A fix that re-stamps a future start time to "now" (as a missing one is) still
// passes this test: the second click is made 3 minutes and 1 second later.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLedger } from "./fake-ledger";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function click(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = click(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  if (typeof f === "function" && own.includes(text)) return f;
  return click(kids, text);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const ESCAPE = "Start a new one anyway";
const A = { id: "A", email: "a@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 20));

function browser() {
  const local = new Map<string, string>();
  const listeners = new Set<() => void>();
  const createWallet = vi.fn(async (): Promise<unknown> => {
    listeners.forEach((cb) => cb());
    return { contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } };
  });
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => {},
    connectWallet: async (): Promise<{ contractId: string } | null> => null,
    createWallet,
    // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
    rpc: { getLatestLedger: async () => ({ sequence: 1000 }) },
  };
  return { local, kit, createWallet };
}

async function render(b: ReturnType<typeof browser>, states: unknown[]) {
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
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(b.kit)) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => b.local.get(k) ?? null, setItem: (k: string, v: string) => void b.local.set(k, v), removeItem: (k: string) => void b.local.delete(k) },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), setters };
}
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v;

/** One unknown creation, then the stored start time is set by `stamp(now)`. Returns the unknown-outcome state. */
async function unknownCreation(b: ReturnType<typeof browser>, stamp: (now: number) => number) {
  const first = await render(b, [{ kind: "idle" }, "Ada", A]);
  await click(first.tree, "Create wallet")!();
  await settle();
  expect(b.createWallet).toHaveBeenCalledTimes(1);
  expect(b.local.get("caracal.creationUnconfirmed")).toBe("A");
  b.local.set("caracal.creationStartedAt", String(stamp(Date.now())));
  b.local.set("caracal.creationCloseLedger", "999"); // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
  vi.resetModules();
  return lastState(first.setters);
}

/** Click "Start a new one anyway" on a page in `state`; returns the new state. */
async function clickEscape(b: ReturnType<typeof browser>, state: unknown) {
  const page = await render(b, [state, "", A]);
  expect(texts(page.tree).join(" | "), "harness: the escape is offered").toContain(ESCAPE);
  await click(page.tree, ESCAPE)!();
  await settle();
  vi.resetModules();
  return lastState(page.setters);
}

describe("adversary r4l: a start time in the future", () => {
  it("control: a start time 4 minutes in the past lets the escape start a new creation", async () => {
    const b = browser();
    const state = await unknownCreation(b, (now) => now - 4 * 60_000);
    await clickEscape(b, state);
    expect(b.createWallet).toHaveBeenCalledTimes(2);
  });

  it("control: a start time of now makes the escape wait (the 3 minute rule works)", async () => {
    const b = browser();
    const state = await unknownCreation(b, (now) => now);
    const after = (await clickEscape(b, state)) as { message?: string };
    expect(b.createWallet).toHaveBeenCalledTimes(1);
    expect(after.message).toContain("less than 3 minutes");
  });

  it("a start time one hour ahead of the clock (the clock was later stepped back) does not block the escape beyond 3 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-26T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const b = browser();
    const state = await unknownCreation(b, (now) => now + 60 * 60_000);
    // First click: refusing is allowed (the attempt's age is unknown).
    const after = await clickEscape(b, state);
    // 3 minutes and 1 second later the escape must work, whatever the stored stamp said.
    vi.setSystemTime(t0 + 3 * 60_000 + 1_000);
    await clickEscape(b, after);
    expect(b.createWallet, "a second creation started after waiting out 3 minutes").toHaveBeenCalledTimes(2);
  });
});
