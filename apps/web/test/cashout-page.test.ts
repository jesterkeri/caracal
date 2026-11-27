// The cash-out page, rendered by calling the component with React's state and
// effects stubbed (as the wallet page tests do).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInfo, parseTransaction } from "../src/lib/anchor/sep24";

type El = { type: unknown; props: { children?: unknown; href?: string; disabled?: boolean } };
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/anchor/${n}`, import.meta.url), "utf8")) as unknown;
const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

// useState order in the page: boot, toml, info, balance, infoError, amountText, phase, session, popupBlocked, confirmed, txn, problem, pollNote, sentHash.
async function render(states: Record<number, unknown>, auth?: unknown) {
  const effects: (() => unknown)[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at in states ? states[at] : init, () => {}];
      },
      useRef: (v: unknown) => ({ current: v }),
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve({}) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const win = { location: { replace: vi.fn(), reload: vi.fn() } };
  vi.stubGlobal("window", win);
  const mod = await import("../src/app/cashout/page");
  return { text: texts(mod.default()).join(""), effects, win };
}

const info = parseInfo(fixture("sep24-info.json"));
const ready = { 0: { kind: "ready", wallet: WALLET }, 2: info, 3: BigInt(90_000_000) };

describe("cash-out page", () => {
  it("always says the withdrawal is simulated and shows the sourced stamp duty note, with no em dash", async () => {
    const { text } = await render({ 0: { kind: "loading" } });
    expect(text).toMatch(/Its withdrawal is simulated/);
    expect(text).toMatch(/no naira reaches a bank/);
    expect(text).toMatch(/Stamp duty may apply/);
    expect(text).toMatch(/deducts nothing/);
    expect(text).toMatch(/Source: Nigeria Tax Act \(NTA\), Ninth Schedule item 33.*PwC and KPMG/);
    expect(text).not.toContain("—");
  });
  it("shows the preview: amount, the fee the anchor will quote, and what arrives", async () => {
    const { text } = await render({ ...ready, 5: "2" });
    expect(text).toContain("2 USDC");
    expect(text).toContain("Quoted by the anchor in its form");
    expect(text).toContain("Shown after the anchor quotes its fee");
    expect(text).toContain("USDC in the wallet: 9 USDC");
  });
  it("names a refused amount", async () => {
    const { text } = await render({ ...ready, 5: "50" });
    expect(text).toContain("The test anchor's largest withdrawal is 10 USDC.");
  });
  it("points a person with no open wallet to the wallet page", async () => {
    const { text } = await render({ 0: { kind: "no-wallet" } });
    expect(text).toContain("href:/wallet");
  });
  it("shows the anchor's quote and the send button only once the anchor asks for USDC, and sends nothing by itself", async () => {
    const txn = parseTransaction(fixture("txn-pending-user-transfer-start.json"));
    const { text } = await render({ ...ready, 6: "confirm", 7: { token: "t", id: "i", url: "https://a.stellar.org" }, 9: BigInt(20_000_000), 10: txn });
    expect(text).toContain("The anchor wants");
    expect(text).toContain("1.8 (simulated)");
    expect(text).toContain("Send 2 USDC to the anchor");
  });
  it("calls a completed withdrawal complete only with the simulation caveat, and links the USDC payment", async () => {
    const txn = parseTransaction(fixture("txn-completed.json"));
    const { text } = await render({ ...ready, 6: "watching", 10: txn, 13: txn.stellarTransactionId });
    expect(text).toMatch(/marked the withdrawal complete.*simulated.*no naira reached a bank/);
    expect(text).toContain("href:https://stellar.expert/explorer/testnet/tx/cb718a83");
    expect(text).toContain("Anchor transaction id: 147a673a-618d-48f5-812e-f9828525d9b0");
  });
  it("does not call a pending withdrawal complete", async () => {
    const txn = { ...parseTransaction(fixture("txn-completed.json")), status: "pending_anchor" };
    const { text } = await render({ ...ready, 6: "watching", 10: txn });
    expect(text).not.toMatch(/marked the withdrawal complete/);
    expect(text).toContain("processing the withdrawal");
  });
  it("sends a signed-out visitor to sign in", async () => {
    const auth = {
      getUser: async () => ({ data: { user: null }, error: null }),
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    };
    const { effects, win } = await render({}, auth);
    effects[0]!();
    await new Promise((r) => setTimeout(r, 30));
    expect(win.location.replace).toHaveBeenCalledWith("/signin");
  });
});
