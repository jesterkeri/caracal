// Codex split R2 (external review of 1eb8954), two findings:
//  1. P1: two tabs could both take the write hold: checking the record, writing it and reading it back
//     are not atomic across tabs, so a tab that did all three between another tab's check and its
//     write let both withdrawals go out.
//  2. P2: verify.ts used the global Buffer, which a browser bundle does not have, so every split was
//     shown as unchecked and its pots and actions never loaded.
import { Address, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locks } from "../src/lib/auth/creation-lock";
import { readInstanceCode } from "../src/lib/split/verify";
import { acquireWrite, holdOn, holdText } from "../src/lib/split/write-guard";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One browser's localStorage, shared by its tabs; `onFirstRead` runs inside the first getItem. */
function sharedStorage(onFirstRead?: () => void) {
  const kept = new Map<string, string>();
  let first = true;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => {
        if (first && onFirstRead) {
          first = false;
          onFirstRead();
        }
        return kept.get(k) ?? null;
      },
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    },
  });
  return kept;
}

/** One browser's Web Locks, shared by its tabs (only { ifAvailable: true }, as the app uses). */
function sharedLocks(): Locks {
  const held = new Set<string>();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

const pendingKit = () => ({ rpc: {}, rpcUrl: "", networkPassphrase: "", signAndSubmit: () => new Promise<never>(() => {}) });

describe("finding 1: only one tab takes the write hold", () => {
  it("a second tab that checks and writes in the middle of the first tab's check is refused", async () => {
    const locks = sharedLocks();
    let second: ReturnType<typeof acquireWrite> | undefined;
    // Tab B starts its whole attempt while tab A is reading the record (after A's check began, before A's write).
    sharedStorage(() => {
      second = acquireWrite(SPLIT, locks);
    });
    const first = await acquireWrite(SPLIT, locks);
    const b = await second!;
    expect([first.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(first.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  it("two tabs starting at the same moment: exactly one goes on", async () => {
    const locks = sharedLocks();
    sharedStorage();
    const both = await Promise.all([acquireWrite(SPLIT, locks), acquireWrite(SPLIT, locks)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
  });

  it("while the first tab's passkey and relay call is still pending, another tab is refused even if the record were gone", async () => {
    const locks = sharedLocks();
    const kept = sharedStorage();
    const first = await acquireWrite(SPLIT, locks);
    if (!first.ok) throw new Error("first should begin");
    void first.guard.kit(pendingKit() as never).signAndSubmit({} as never);
    first.guard.finish({ kind: "unknown", message: "no answer" });
    kept.clear(); // storage cleared by the person, or by the browser
    const second = await acquireWrite(SPLIT, locks);
    expect(second.ok).toBe(false);
  });

  it("after a certain outcome the lock is let go and the next write may start", async () => {
    const locks = sharedLocks();
    sharedStorage();
    const first = await acquireWrite(SPLIT, locks);
    if (!first.ok) throw new Error("first should begin");
    first.guard.finish({ kind: "done", hash: "ab".repeat(32) } as never);
    await first.guard.released;
    await Promise.resolve();
    const second = await acquireWrite(SPLIT, locks);
    expect(second.ok).toBe(true);
  });

  it("after an unknown outcome the lock is let go once the kit call settles, and the record still holds", async () => {
    const locks = sharedLocks();
    sharedStorage();
    const first = await acquireWrite(SPLIT, locks);
    if (!first.ok) throw new Error("first should begin");
    let settle!: () => void;
    const kit = { ...pendingKit(), signAndSubmit: () => new Promise<void>((r) => (settle = r)) };
    void first.guard.kit(kit as never).signAndSubmit({} as never);
    first.guard.finish({ kind: "unknown", message: "no answer" });
    settle();
    await first.guard.released;
    await Promise.resolve();
    expect(holdOn(SPLIT).held).toBe(true);
    const second = await acquireWrite(SPLIT, locks);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.hold.reason).toBe("earlier-write");
  });

  it("a browser without Web Locks sends nothing, and says why", async () => {
    sharedStorage();
    vi.stubGlobal("navigator", {});
    const r = await acquireWrite(SPLIT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hold.reason).toBe("unsupported");
      expect(holdText(r.hold)).toMatch(/sends nothing from it/);
    }
  });

  it("a browser that refuses the lock request sends nothing", async () => {
    sharedStorage();
    const refusing: Locks = { request: () => Promise.reject(new DOMException("blocked", "SecurityError")) };
    const r = await acquireWrite(SPLIT, refusing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold.reason).toBe("unreadable");
  });
});

describe("finding 2: the wasm check does not need a global Buffer", () => {
  it("reads a split's wasm hash with no global Buffer, as in a browser bundle", async () => {
    const hash = Buffer.alloc(32, 7);
    const val = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: new Address(SPLIT).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(hash), storage: null })),
      }),
    );
    // The global goes once the request is made (the stellar-sdk this test runs from source uses it to build
    // the key; its browser bundle brings its own), so what follows runs as in a browser without it.
    const server = {
      getLedgerEntries: async () => {
        vi.stubGlobal("Buffer", undefined);
        return { entries: [{ val }] };
      },
    };
    const code = await readInstanceCode(server, SPLIT);
    vi.unstubAllGlobals();
    expect(code).toEqual({ kind: "wasm", hash: "07".repeat(32) });
  });
});
