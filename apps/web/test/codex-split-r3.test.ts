// Codex split R3 (2026-11-28): a forward clock jump released an uncertain write's hold early, because the hold
// was measured on the browser's clock. Now each write fixes its last ledger (closeBy) before it is sent, the
// passkey signs with that expiry, and the hold lifts only when an RPC shows a ledger past closeBy.
// (The guard's API changed with the fix, from a clock to a ledger, so these run against the new API only.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIT_DEFAULT_LEDGERS, WRITE_LEDGERS, beginWrite, holdOn, readLedger } from "../src/lib/split/write-guard";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);
const KEY = `caracal.split.write.${SPLIT}`;
const HOUR = 3_600_000;

function stubStorage(kept = new Map<string, string>()) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
  });
  return kept;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/split/actions"]) vi.doUnmock(m);
  vi.resetModules();
});

describe("Codex split R3: no clock decides when an uncertain write can no longer land", () => {
  it("a clock jumped an hour forward after an unknown write does not release it before closeBy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    stubStorage();
    const first = beginWrite(SPLIT, 1000);
    if (!first.ok) throw new Error("should begin");
    first.guard.finish({ kind: "unknown", message: "no answer" });
    vi.setSystemTime(1_800_000_000_000 + HOUR);
    expect(holdOn(SPLIT, 1001).held).toBe(true);
    expect(holdOn(SPLIT, 1000 + WRITE_LEDGERS, Date.now()).held).toBe(true);
    expect(beginWrite(SPLIT, 1001).ok).toBe(false);
    expect(holdOn(SPLIT, 1001 + WRITE_LEDGERS).held).toBe(false);
  });

  it("the passkey signs with the write's closeBy as its expiry ledger", () => {
    stubStorage();
    const first = beginWrite(SPLIT, 5000);
    if (!first.ok) throw new Error("should begin");
    const signAndSubmit = vi.fn(async (_tx: unknown, _o?: { expiration?: number }) => ({ success: true as const, hash: "ab" }));
    const tx = { needsNonInvokerSigningBy: () => [WALLET] };
    void first.guard.kit({ rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit } as never).signAndSubmit(tx as never);
    expect(signAndSubmit).toHaveBeenCalledWith(tx, { expiration: 5000 + WRITE_LEDGERS });
  });

  it("a call that needs no signature from the wallet is not sent, and says nothing was sent", async () => {
    stubStorage();
    const first = beginWrite(SPLIT, 5000);
    if (!first.ok) throw new Error("should begin");
    const signAndSubmit = vi.fn();
    const r = await first.guard.kit({ rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit } as never).signAndSubmit({ needsNonInvokerSigningBy: () => [] } as never);
    expect(signAndSubmit).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(!r.success && r.error.message).toMatch(/Nothing was sent/);
  });

  it("a record from the older, clock-based version is held past the kit's default expiry from the ledger it is first seen at", () => {
    const kept = stubStorage();
    kept.set(KEY, JSON.stringify({ id: "old", beat: Date.now() - HOUR }));
    expect(holdOn(SPLIT, null).held).toBe(true);
    expect(holdOn(SPLIT, 2000).held).toBe(true);
    // fixed at the first ledger it was seen at, not moved by later reads
    expect(holdOn(SPLIT, 2000 + KIT_DEFAULT_LEDGERS).held).toBe(true);
    expect(holdOn(SPLIT, 2001 + KIT_DEFAULT_LEDGERS).held).toBe(false);
  });

  it("readLedger refuses an answer without a ledger number", async () => {
    await expect(readLedger({ getLatestLedger: async () => ({ sequence: 1234 }) })).resolves.toBe(1234);
    await expect(readLedger({ getLatestLedger: async () => ({}) })).rejects.toThrow(/did not say which ledger/);
    await expect(readLedger({ getLatestLedger: async () => ({ sequence: -1 }) })).rejects.toThrow(/did not say which ledger/);
  });
});

// ---- the page ----
type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function button(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = button(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  return typeof f === "function" && own.includes(text) ? f : button(kids, text);
}

const READY = { kind: "ready", wallet: WALLET, loaded: { kind: "present", split: SPLIT, pots: { tax: BigInt(0), goal: BigInt(0), spend: BigInt(90_000) }, config: { owner: WALLET, token: TOKENS.usdc, taxBps: 1000, goalBps: 1500 } } };
const FORM = { deployTax: "", deployGoal: "", wdPot: "Spend", wdAmount: "0.001", moveFrom: "Spend", moveTo: "Goal", moveAmount: "", newTax: "", newGoal: "" };

/** States, in order: view, form, note, account, tick, seenLedger. */
async function page(kept: Map<string, string>, seenLedger: number | null, rpc: unknown) {
  stubStorage(kept);
  const setters: { i: number; v: unknown }[] = [];
  const states: unknown[] = [READY, FORM, {}, { id: "A", email: "a@x.ng" }, 0, seenLedger];
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
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: {} }) }));
  const kit = { rpc, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }) };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const withdrawToWallet = vi.fn(async () => ({ kind: "unknown", message: "no answer" }));
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), withdrawToWallet, loadSplit: vi.fn(async () => READY.loaded) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/split/page");
  return { tree: mod.default(), setters, withdrawToWallet };
}
const record = (closeBy: number) => new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy })]]);

describe("Codex split R3 on the page", () => {
  it("control: with the network past the record's closeBy, no hold is shown", async () => {
    const p = await page(record(1060), 1061, {});
    expect(texts(p.tree)).not.toMatch(/may still go through/);
  });

  it("with the network at closeBy, the hold is shown", async () => {
    const p = await page(record(1060), 1060, {});
    expect(texts(p.tree)).toMatch(/may still go through/);
  });

  it("with no ledger read yet, the hold is shown", async () => {
    const p = await page(record(1060), null, {});
    expect(texts(p.tree)).toMatch(/may still go through/);
  });

  it("a write whose ledger cannot be read sends nothing and says so", async () => {
    const p = await page(new Map(), null, { getLatestLedger: async () => Promise.reject(new Error("down")) });
    await button(p.tree, "Withdraw with my passkey")!();
    expect(p.withdrawToWallet).not.toHaveBeenCalled();
    const said = p.setters.filter((s) => s.i === 2).at(-1)?.v as { said?: { text: string } };
    expect(said.said?.text).toMatch(/could not read the Stellar network, so nothing was signed or sent/);
  });
});

// Adversary s11 (kept as adversary-s11-lock-outlives-closeby.test.ts) with a kit call that truly never settles.
describe("adversary s11 follow-up: the lock of a write whose kit call never settles", () => {
  it("holds through closeBy and is let go once the network passes it", async () => {
    stubStorage();
    const { acquireWrite } = await import("../src/lib/split/write-guard");
    const first = await acquireWrite(SPLIT, 1000);
    if (!first.ok) throw new Error("should begin");
    const kit = { rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit: () => new Promise<never>(() => {}) };
    void first.guard.kit(kit as never).signAndSubmit({} as never);
    first.guard.finish({ kind: "unknown", message: "no answer within 5 minutes" });
    expect((await acquireWrite(SPLIT, 1000 + WRITE_LEDGERS)).ok).toBe(false);
    const second = await acquireWrite(SPLIT, 1001 + WRITE_LEDGERS);
    expect(second.ok).toBe(true);
    if (second.ok) second.guard.finish({ kind: "done", hash: "ab" });
  });

  it("a record past its closeBy is removed, so the page stops reading the ledger for it", async () => {
    const kept = stubStorage(new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: 1060 })]]));
    const { hasWriteRecord } = await import("../src/lib/split/write-guard");
    expect(holdOn(SPLIT, 1060).held).toBe(true);
    expect(hasWriteRecord(SPLIT)).toBe(true);
    expect(holdOn(SPLIT, 1061).held).toBe(false);
    expect(kept.has(KEY)).toBe(false);
    expect(hasWriteRecord(SPLIT)).toBe(false);
  });
});

describe("adversary s12 follow-up: a call whose signers cannot be read", () => {
  it("is not sent, and says nothing was sent", async () => {
    stubStorage();
    const first = beginWrite(SPLIT, 5000);
    if (!first.ok) throw new Error("should begin");
    const signAndSubmit = vi.fn();
    const tx = {
      needsNonInvokerSigningBy: () => {
        throw new Error("not simulated");
      },
    };
    const r = await first.guard.kit({ rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit } as never).signAndSubmit(tx as never);
    expect(signAndSubmit).not.toHaveBeenCalled();
    expect(!r.success && r.error.message).toMatch(/Nothing was sent/);
  });
});
