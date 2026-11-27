// Codex split R1 (external review of d47b8b2), three findings:
//  1. P1: an unknown withdrawal or move can be repeated while the first may still land.
//  2. P2: the page showed balances as USDC without checking the split's wasm or token.
//  3. Wording: a contract error code was attributed to the split without knowing which contract raised it.
import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSplit } from "../src/lib/split/actions";
import { splitErrorText } from "../src/lib/split/errors";
import { readPots } from "../src/lib/split/chain";
import { HEARTBEAT_MS, SETTLE_MS, beginWrite, holdOn } from "../src/lib/split/write-guard";
import { SPLIT as SPLIT_CFG, TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);
const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/split/actions");
  vi.resetModules();
});

function stubStorage(kept = new Map<string, string>(), overrides: Partial<Storage> = {}) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k), ...overrides },
  });
  return kept;
}

// ---- 1. an uncertain write holds back every new write ----
describe("finding 1: an unknown write cannot be repeated while it may still land", () => {
  beforeEach(() => vi.useFakeTimers());

  it("while the first signAndSubmit is still pending, the hold is renewed far past the page's 5 minute wait", () => {
    stubStorage();
    const first = beginWrite(SPLIT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const kit = { rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit: () => new Promise<never>(() => {}) };
    const watched = first.guard.kit(kit as never);
    void watched.signAndSubmit({} as never); // never settles: sendSplitCall gave up at 5 minutes
    first.guard.finish({ kind: "unknown", message: "no answer within 5 minutes" });
    vi.advanceTimersByTime(20 * MIN);
    expect(holdOn(SPLIT).held).toBe(true);
    expect(beginWrite(SPLIT).ok).toBe(false);
  });

  it("once the first has settled, the hold lifts after the settle window and not before", () => {
    stubStorage();
    let settle!: () => void;
    const first = beginWrite(SPLIT);
    if (!first.ok) throw new Error("should begin");
    const kit = { rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit: () => new Promise<void>((r) => (settle = r)) };
    void first.guard.kit(kit as never).signAndSubmit({} as never);
    first.guard.finish({ kind: "unknown", message: "x" });
    vi.advanceTimersByTime(6 * MIN);
    expect(holdOn(SPLIT).held).toBe(true);
    settle();
    return Promise.resolve().then(() => {
      vi.advanceTimersByTime(SETTLE_MS - HEARTBEAT_MS);
      expect(holdOn(SPLIT).held).toBe(true);
      vi.advanceTimersByTime(2 * HEARTBEAT_MS);
      expect(holdOn(SPLIT).held).toBe(false);
    });
  });

  it("a reload does not release it: another page reading the same storage is held, then released after the window", () => {
    const kept = stubStorage();
    const first = beginWrite(SPLIT);
    if (!first.ok) throw new Error("should begin");
    first.guard.finish({ kind: "unknown", message: "x" });
    // The tab is gone (no more renewals); a new page reads the same storage.
    vi.advanceTimersByTime(SETTLE_MS - 1_000);
    stubStorage(kept);
    expect(holdOn(SPLIT).held).toBe(true);
    expect(beginWrite(SPLIT).ok).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(holdOn(SPLIT).held).toBe(false);
  });

  it("a certain outcome releases at once", () => {
    stubStorage();
    const g = beginWrite(SPLIT);
    if (!g.ok) throw new Error("should begin");
    expect(holdOn(SPLIT).held).toBe(true);
    g.guard.finish({ kind: "done", hash: "ab" });
    expect(holdOn(SPLIT).held).toBe(false);
  });

  it("storage that cannot be read holds back, and storage that cannot be written refuses to start", () => {
    stubStorage(new Map(), {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(holdOn(SPLIT).held).toBe(true);
    expect(beginWrite(SPLIT).ok).toBe(false);
    stubStorage(new Map(), {
      setItem: () => {
        throw new Error("full");
      },
    });
    expect(beginWrite(SPLIT).ok).toBe(false);
    vi.stubGlobal("window", {});
    expect(holdOn(SPLIT).held).toBe(true);
  });

  it("a record that cannot be parsed holds for the window, then lifts", () => {
    const kept = stubStorage();
    kept.set(`caracal.split.write.${SPLIT}`, "{not json");
    expect(holdOn(SPLIT).held).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS + 1_000);
    expect(holdOn(SPLIT).held).toBe(false);
  });

  it("the page: after an unknown withdrawal, a second click sends nothing and says the first may still go through", async () => {
    vi.useRealTimers();
    const kept = stubStorage();
    const effects: (() => unknown)[] = [];
    const setters: { i: number; v: unknown }[] = [];
    const states: unknown[] = [
      { kind: "ready", wallet: WALLET, loaded: { kind: "present", split: SPLIT, pots: { tax: BigInt(0), goal: BigInt(0), spend: BigInt(90_000) }, config: { owner: WALLET, token: TOKENS.usdc, taxBps: 1000, goalBps: 1500 } } },
      { deployTax: "", deployGoal: "", wdPot: "Spend", wdAmount: "0.001", moveFrom: "Spend", moveTo: "Goal", moveAmount: "", newTax: "", newGoal: "" },
      {},
      { id: "A", email: "a@x.ng" },
    ];
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
    vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: {} }) }));
    const kit = { rpc: {}, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }) };
    vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
    const withdrawToWallet = vi.fn(async () => ({ kind: "unknown", message: "no answer within 5 minutes" }));
    const loadSplitFake = vi.fn(async () => states[0]);
    vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), withdrawToWallet, loadSplit: loadSplitFake }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    const mod = await import("../src/app/split/page");
    const click = async () => {
      const tree = mod.default();
      const find = (n: unknown): { props?: { onClick?: () => unknown; disabled?: boolean } } | null => {
        if (Array.isArray(n)) return n.map(find).find(Boolean) ?? null;
        if (typeof n !== "object" || n === null) return null;
        const el = n as { props?: { children?: unknown; onClick?: () => unknown } };
        const kids = el.props?.children;
        const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
        return typeof el.props?.onClick === "function" && own.includes("Withdraw with my passkey") ? el : find(kids);
      };
      return find(tree);
    };
    const first = await click();
    await first!.props!.onClick!();
    expect(withdrawToWallet).toHaveBeenCalledTimes(1);
    expect(kept.size).toBe(1); // the record stays: the first may still land
    // The first write's own re-read has put the pots back; the person clicks again.
    const second = first;
    await second!.props!.onClick!();
    expect(withdrawToWallet).toHaveBeenCalledTimes(1);
    const said = setters.filter((s) => s.i === 2).at(-1)?.v as { said?: { tone: string; text: string } };
    expect(said.said?.text).toMatch(/may still go through/);
  });
});

// ---- 2. the split's code and token are checked before anything is shown ----
const BALANCES = "AAAAEAAAAAEAAAADAAAACgAAAAAAAAAAAAAAAAAAJxAAAAAKAAAAAAAAAAAAAAAAAAA6mAAAAAoAAAAAAAAAAAAAAAAAAST4";
const OTHER_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const config = (token: string) => xdr.ScVal.scvVec([nativeToScVal(Address.fromString(WALLET)), nativeToScVal(Address.fromString(token)), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)]);
const ok = (v: xdr.ScVal) => ({ result: { retval: v, auth: [] }, latestLedger: 1 }) as unknown as rpc.Api.SimulateTransactionResponse;
const instance = (exe: xdr.ContractExecutable) =>
  xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(SPLIT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: exe, storage: null })),
    }),
  );
const wasm = (hex: string) => instance(xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex")));

function network(opts: { code: () => Promise<{ val?: xdr.LedgerEntryData }[]>; token?: string }) {
  let first = true;
  return {
    async simulateTransaction(tx: { operations: { func: xdr.HostFunction }[] }) {
      const fn = tx.operations[0].func.invokeContract().functionName().toString();
      return fn === "balances" ? ok(xdr.ScVal.fromXDR(BALANCES, "base64")) : ok(config(opts.token ?? TOKENS.usdc));
    },
    // The first lookup is the existence check (any live entry); the next is the one for the code.
    async getLedgerEntries() {
      if (first) {
        first = false;
        return { entries: [{ liveUntilLedgerSeq: 500 }], latestLedger: 100 };
      }
      return { entries: await opts.code(), latestLedger: 100 };
    },
  } as never;
}

describe("finding 2: the split's code and token are checked", () => {
  it("control: Caracal's split code over USDC is shown", async () => {
    const l = await loadSplit(network({ code: async () => [{ val: wasm(SPLIT_CFG.wasmHash) }] }), WALLET);
    expect(l.kind).toBe("present");
  });
  it("a different contract at the address shows no balances", async () => {
    const l = await loadSplit(network({ code: async () => [{ val: wasm("11".repeat(32)) }] }), WALLET);
    expect(l.kind).toBe("error");
    expect(l.kind === "error" && l.message).toMatch(/does not run Caracal's split code/);
  });
  it("a split over another token shows no balances as USDC", async () => {
    const l = await loadSplit(network({ code: async () => [{ val: wasm(SPLIT_CFG.wasmHash) }], token: OTHER_TOKEN }), WALLET);
    expect(l.kind).toBe("error");
    expect(l.kind === "error" && l.message).toMatch(/other than USDC/);
  });
  it("an instance that is not a wasm contract is refused", async () => {
    const l = await loadSplit(network({ code: async () => [{ val: instance(xdr.ContractExecutable.contractExecutableStellarAsset()) }] }), WALLET);
    expect(l.kind).toBe("error");
  });
  it("a lookup that fails, answers nothing usable or never answers is 'could not be checked', not a pass", async () => {
    const failed = await loadSplit(network({ code: async () => Promise.reject(new Error("down")) }), WALLET);
    expect(failed.kind === "error" && failed.message).toMatch(/could not check/);
    const noValue = await loadSplit(network({ code: async () => [{}] }), WALLET);
    expect(noValue.kind === "error" && noValue.message).toMatch(/could not check/);
    vi.useFakeTimers();
    const hung = loadSplit(network({ code: () => new Promise<never>(() => {}) }), WALLET);
    await vi.advanceTimersByTimeAsync(60_000);
    const l = await hung;
    expect(l.kind === "error" && l.message).toMatch(/could not check/);
  });
});

// ---- 3. a contract error code is not blamed on the split unless the split raised it ----
describe("finding 3: error codes are attributed only to the contract that raised them", () => {
  const event = (c: string, n: number) => `HostError: Error(Contract, #${n})\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:${c}, topics:[error, Error(Contract, #${n})], data:"x"`;
  it("a code raised by the USDC contract is not read as the split's", () => {
    const text = splitErrorText(event(TOKENS.usdc, 4), SPLIT);
    expect(text).not.toMatch(/pot/);
    expect(text).toMatch(/USDC contract refused/);
  });
  it("a code raised by some other contract is not read as the split's", () => {
    expect(splitErrorText(event(WALLET, 4), SPLIT)).not.toMatch(/does not hold enough/);
  });
  it("the oldest line naming a contract decides, as the error passes up through its callers", () => {
    const both = `${event(SPLIT, 4)}\n   1: [Diagnostic Event] contract:${TOKENS.usdc}, topics:[error, Error(Contract, #4)], data:"y"`;
    expect(splitErrorText(both, SPLIT)).toMatch(/USDC contract refused/);
  });
  it("a code raised by the split is still named", () => {
    expect(splitErrorText(event(SPLIT, 4), SPLIT)).toMatch(/does not hold enough/);
  });
  it("a read of the pots that fails in the USDC contract does not say the split refused", async () => {
    const server = { simulateTransaction: async () => ({ error: event(TOKENS.usdc, 4), latestLedger: 1, events: [], id: "x", _parsed: true }) } as never;
    await expect(readPots(server, SPLIT)).rejects.toThrow(/USDC contract refused/);
  });
});
