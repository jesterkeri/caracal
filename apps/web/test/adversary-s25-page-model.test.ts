// Adversary s25: a seeded model check of the split PAGE (src/app/split/page.tsx) with the real write guard and the real
// sendSplitCall, against a fake chain, a lagging RPC and a second tab.
//
// Random steps: time passing (a ledger every 5 s), the person pressing Withdraw or Refresh on the page, the page's write
// ending (done with or without the ledger, refused, unknown, never answering), a write landing late (an unknown or silent
// write still lands in any ledger up to its closeBy), reads of the ledger and of the pots answered by a node a few
// ledgers behind, and a second tab of the same browser starting and ending writes through its own copy of the guard.
//
// What must hold (write-guard.ts header; decisions 2026-11-28 Codex split R4 to R6, adversary s15 to s23):
//   1. A write reaches signAndSubmit only when no other write of this split may still land (its closeBy is behind the real ledger).
//   2. It reaches it only on pots that include every write that went through.
//   3. Liveness: once every write has ended and the network is healthy, the page offers Withdraw again within about 20 minutes
//      (pressing the buttons the page itself offers: Try again, "I have checked the pots", Refresh).
// Also drawn: odd values in storage (an unreadable record, one with a closeBy beyond u32, a damaged read-after ledger), a
// storage that refuses the read-after key or removals, an RPC that is down, and a reload of the page's tab (its locks go, the
// writes it sent may still land).
//
// Result on d0a4a74: no violation in about 4000 seeded runs (seeds 1 to 2000, 45 to 90 steps). A control for sensitivity, run
// once and not kept: with the page's `readPastBy` import replaced by `recordCloseBy` (the s20 bug) seeds 7, 13 and 31 fail with
// "Withdraw offered ... on pots showing ... the chain holds ...". `S25_SEEDS`, `S25_FROM` and `S25_STEPS` widen the search.
// A write lands in the ledger after the latest one an RPC can show, and only up to its closeBy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

type El = { props?: { children?: unknown; onClick?: () => unknown; onChange?: (e: unknown) => unknown; placeholder?: string; disabled?: boolean } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function find(node: unknown, pred: (e: El) => boolean): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = find(n, pred);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  if (pred(node as El)) return node as El;
  return find((node as El).props?.children, pred);
}
const button = (tree: unknown, text: string) => find(tree, (e) => typeof e.props?.onClick === "function" && texts(e.props?.children).join("").includes(text));
const input = (tree: unknown, placeholder: string) => find(tree, (e) => e.props?.placeholder === placeholder);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/split/actions");
  vi.resetModules();
});

const SPLIT = splitAddressFor(WALLET);
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const ONE = BigInt(10_000_000);
const START_SPEND = BigInt(100) * ONE;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Inst = {
  slots: unknown[];
  effectDeps: (unknown[] | undefined)[];
  cleanups: ((() => void) | undefined)[];
  pending: (() => void)[];
  dead: boolean;
  renderQueued: boolean;
  tree: unknown;
  render: () => void;
};

type W = { id: number; who: "page" | "tab2"; closeBy: number; landedAt: number | null; ended: boolean; neverLands: boolean; orphan?: boolean; settle?: (r: unknown) => void; fail?: (e: unknown) => void };

const stats = { pageSends: 0, tab2Begins: 0, offered: 0, lived: 0, reloads: 0 };

async function run(seed: number, steps: number) {
  const r = rng(seed);
  vi.resetModules();
  vi.useFakeTimers();
  let cur!: Inst;
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let s = 0;
    let e = 0;
    (globalThis as { __hooks?: { reset(): void } }).__hooks = { reset: () => ((s = 0), (e = 0)) };
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const my = cur;
        const at = s++;
        if (!(at in my.slots)) my.slots[at] = init;
        return [
          my.slots[at],
          (v: unknown) => {
            my.slots[at] = typeof v === "function" ? (v as (p: unknown) => unknown)(my.slots[at]) : v;
            if (!my.renderQueued && !my.dead) {
              my.renderQueued = true;
              setTimeout(() => {
                my.renderQueued = false;
                if (!my.dead) my.render();
              }, 0);
            }
          },
        ];
      },
      useEffect: (fn: () => unknown, deps?: unknown[]) => {
        const my = cur;
        const at = e++;
        const before = my.effectDeps[at];
        const same = before !== undefined && deps !== undefined && before.length === deps.length && before.every((d, i) => Object.is(d, deps[i]));
        if (same) return;
        my.effectDeps[at] = deps;
        my.pending.push(() => {
          my.cleanups[at]?.();
          const c = fn();
          my.cleanups[at] = typeof c === "function" ? (c as () => void) : undefined;
        });
      },
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: ME }, error: null }),
    getSession: async () => ({ data: { session: { user: ME } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));

  // The chain: the real ledger, and every write that landed.
  const net = { ledger: 1000, lagLedger: 0, lagRead: 0, readMs: 10, ledgerDown: false, readDown: false };
  const writes: W[] = [];
  const landed = () => writes.filter((w) => w.landedAt !== null);
  const spendAsOf = (at: number) => START_SPEND - ONE * BigInt(landed().filter((w) => w.landedAt! <= at).length);
  const violations: string[] = [];
  const log: string[] = [];
  // A write lands in the ledger being closed, one past the latest the RPC can show, and only if that is within its closeBy.
  const mayStillLand = (w: W) => !w.neverLands && w.landedAt === null && w.closeBy >= net.ledger + 1;
  const land = (w: W) => {
    if (mayStillLand(w)) {
      w.landedAt = net.ledger + 1;
      log.push(`write ${w.id} (${w.who}) landed at ${net.ledger + 1}`);
    }
  };

  let clickShown: bigint | null = null;
  /** When another tab last acted: the page shows what that tab did only from its next render (the poll renders every 5 s). */
  let external = 0;
  const makeKit = () => ({
    rpc: {
      getLatestLedger: async () => {
        if (net.ledgerDown) throw new Error("rpc down");
        return { sequence: Math.max(1, net.ledger - net.lagLedger) };
      },
    },
    disconnect: async () => {},
    connectWallet: async () => ({ contractId: WALLET }),
    signAndSubmit: (_tx: unknown, options?: { expiration?: number }) => {
      const w: W = { id: writes.length, who: "page", closeBy: options?.expiration ?? -1, landedAt: null, ended: false, neverLands: false };
      // 1. no other write may still land
      for (const o of writes) {
        if (mayStillLand(o)) violations.push(`seed ${seed}: page write ${w.id} sent at ledger ${net.ledger} while write ${o.id} (${o.who}, closeBy ${o.closeBy}) may still land`);
      }
      // 2. the pots it was clicked on include every write that went through
      const real = START_SPEND - ONE * BigInt(landed().length);
      if (clickShown !== null && clickShown !== real) violations.push(`seed ${seed}: page write sent on pots showing ${clickShown} but the chain holds ${real}: ${log.slice(-16).join(" | ")}`);
      writes.push(w);
      stats.pageSends++;
      log.push(`page write ${w.id} sent at ${net.ledger}, closeBy ${w.closeBy}`);
      return new Promise((resolve, reject) => {
        w.settle = resolve;
        w.fail = reject;
      });
    },
  });
  let kit = makeKit();
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));

  const loadSplit = vi.fn(async () => {
    const asOf = Math.max(1, net.ledger - net.lagRead);
    const spend = spendAsOf(asOf);
    await new Promise((res) => setTimeout(res, net.readMs));
    if (net.readDown) return { kind: "error", split: SPLIT, message: "Caracal could not reach the Stellar network to look for your split contract." };
    return { kind: "present", split: SPLIT, pots: { tax: BigInt(0), goal: BigInt(0), spend }, config: CONFIG, ledger: asOf };
  });
  const send = await import("../src/lib/split/send");
  const calls = await import("../src/lib/split/calls");
  const fakeBuild = async () => ({ needsNonInvokerSigningBy: () => [WALLET] }) as never;
  const withdrawToWallet = vi.fn(async (k: Parameters<typeof send.sendSplitCall>[0], _wallet: string, _pots: unknown, pot: "Spend", amount: bigint) =>
    send.sendSplitCall(k, calls.withdrawFunction(SPLIT, pot, WALLET, amount), "withdraw", SPLIT, fakeBuild),
  );
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit, withdrawToWallet }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = new Map([["caracal.walletOwner", ME.id]]);
  const refuse = { after: false, remove: false };
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse.after && k.includes("readAfter")) throw new Error("quota");
        local.set(k, v);
      },
      removeItem: (k: string) => {
        if (refuse.remove && k.includes("split.write")) throw new Error("refused");
        local.delete(k);
      },
    },
  });
  // Web Locks that know which tab holds each lock, so a tab that dies (a reload) lets its locks go.
  type Owner = { actor: "tab1" | "tab2" };
  const held = new Map<string, Owner>();
  let actor: "tab1" | "tab2" = "tab1";
  const fakeLocks = {
    async request(name: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) {
      if (held.has(name)) return cb(null);
      const mine: Owner = { actor };
      held.set(name, mine);
      try {
        return await cb({ name });
      } finally {
        if (held.get(name) === mine) held.delete(name);
      }
    },
  };
  const navDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
  Object.defineProperty(globalThis.navigator, "locks", { value: fakeLocks, configurable: true });
  let mod = await import("../src/app/split/page");
  // The second tab: its own copy of the guard (own live writes), the same storage and Web Locks.
  vi.resetModules();
  const tab2 = await import("../src/lib/split/write-guard");
  const locks = fakeLocks as unknown as Parameters<typeof tab2.acquireWrite>[2];

  let inst!: Inst;
  const openPage = () => {
    const i: Inst = { slots: [], effectDeps: [], cleanups: [], pending: [], dead: false, renderQueued: false, tree: null, render: () => {} };
    i.render = () => {
      cur = i;
      (globalThis as { __hooks?: { reset(): void } }).__hooks!.reset();
      i.tree = mod.default();
      const todo = i.pending.splice(0);
      setTimeout(() => todo.forEach((f) => f()), 0);
    };
    inst = i;
    i.render();
  };
  openPage();
  const tick = setInterval(() => {
    net.ledger++;
    // writes land at random while they still can
    for (const w of writes) if (!w.ended && r() < 0.3) land(w);
  }, 5_000);

  const text = () => texts(inst.tree).join(" ");
  const withdrawEnabled = () => {
    const b = button(inst.tree, "Withdraw with my passkey");
    return b !== null && b.props?.disabled !== true;
  };
  const shownSpend = (): bigint | null => {
    const m = /Spend\s+(\d+)\.(\d+)/.exec(text());
    if (!m) return null;
    return BigInt(m[1]!) * ONE + BigInt(m[2]!.padEnd(7, "0"));
  };
  const advance = async (ms: number) => {
    for (let t = 0; t < ms; t += 500) await vi.advanceTimersByTimeAsync(Math.min(500, ms - t));
  };

  const tab2Writes: { w: W; guard: import("../src/lib/split/write-guard").WriteGuard }[] = [];
  await advance(2_000);

  try {
    for (let step = 0; step < steps; step++) {
      const op = Math.floor(r() * 18);
      if (op <= 1) {
        const ms = [500, 2_000, 5_000, 12_000, 40_000, 130_000][Math.floor(r() * 6)]!;
        await advance(ms);
      } else if (op === 2) {
        net.lagLedger = Math.floor(r() * 4);
        net.lagRead = Math.floor(r() * 6);
        net.readMs = [10, 800, 4_000][Math.floor(r() * 3)]!;
        log.push(`lag ledger ${net.lagLedger}, read ${net.lagRead}, readMs ${net.readMs}`);
      } else if (op === 3 || op === 4) {
        if (withdrawEnabled()) {
          clickShown = shownSpend();
          log.push(`click Withdraw at ledger ${net.ledger}, showing ${clickShown}`);
          input(inst.tree, "25.00")!.props!.onChange!({ target: { value: "1" } });
          await advance(10);
          button(inst.tree, "Withdraw with my passkey")!.props!.onClick!();
          await advance(r() < 0.5 ? 50 : 3_000);
        }
      } else if (op === 5) {
        const b = button(inst.tree, "Refresh");
        if (b && b.props?.disabled !== true) {
          log.push("click Refresh");
          b.props!.onClick!();
          await advance(100);
        }
      } else if (op === 6 || op === 7) {
        // the page's own write ends
        const open = writes.filter((w) => w.who === "page" && !w.ended && !w.orphan && w.settle);
        if (open.length === 0) continue;
        const w = open[Math.floor(r() * open.length)]!;
        const k = r();
        if (k < 0.3) {
          land(w);
          const at = w.landedAt;
          if (at !== null) {
            log.push(`page write ${w.id} ends done (ledger ${r() < 0.7 ? at : "unsaid"})`);
            w.settle!({ success: true, hash: "a".repeat(64), ledger: r() < 0.7 ? at : undefined });
            w.ended = true;
          }
        } else if (k < 0.5 && w.landedAt === null) {
          log.push(`page write ${w.id} ends refused`);
          w.neverLands = true;
          w.settle!({ success: false, error: Object.assign(new Error("The fee relayer refused this transaction (POOL_CAPACITY). Nothing was sent."), { name: "Error" }) });
          w.ended = true;
        } else if (k < 0.6 && w.landedAt === null) {
          log.push(`page write ${w.id} ends stopped (prompt closed)`);
          w.neverLands = true;
          w.settle!({ success: false, error: Object.assign(new Error("closed"), { name: "WebAuthnError", cause: Object.assign(new Error("x"), { name: "NotAllowedError" }) }) });
          w.ended = true;
        } else if (k < 0.8) {
          log.push(`page write ${w.id} ends unknown (rejects)`);
          w.fail!(new Error("Relayer request timed out"));
          // it may still land later
        }
        // else: stays silent (never answers)
      } else if (op === 8) {
        // the second tab starts a write
        const shownAt = r() < 0.1 ? null : net.ledger - Math.floor(r() * 30);
        const seen = Math.max(1, net.ledger - Math.floor(r() * 3));
        actor = "tab2";
        const res = await tab2.acquireWrite(SPLIT, seen, locks, shownAt);
        actor = "tab1";
        if (res.ok) {
          const w: W = { id: writes.length, who: "tab2", closeBy: res.guard.closeBy, landedAt: null, ended: false, neverLands: false };
          for (const o of writes) {
            if (mayStillLand(o)) violations.push(`seed ${seed}: tab2 write sent at ledger ${net.ledger} (read ${seen}) while write ${o.id} (${o.who}, closeBy ${o.closeBy}) may still land`);
          }
          const real = START_SPEND - ONE * BigInt(landed().length);
          if (shownAt !== null && spendAsOf(shownAt) !== real) violations.push(`seed ${seed}: tab2 write started on pots read at ${shownAt}, which miss a write that landed`);
          writes.push(w);
          external = Date.now();
          tab2Writes.push({ w, guard: res.guard });
          stats.tab2Begins++;
          log.push(`tab2 write ${w.id} begins (seen ${seen}), closeBy ${w.closeBy}`);
        }
      } else if (op === 15 || op === 16) {
        // the second tab's poll: it reads a ledger (a node up to 3 behind), lets go of what the network passed, clears a passed record
        const seen = Math.max(1, net.ledger - Math.floor(r() * 4));
        actor = "tab2";
        await tab2.passLedger(SPLIT, seen);
        await tab2.clearPassed(SPLIT, seen, locks);
        actor = "tab1";
        log.push(`tab2 poll at ${seen}`);
      } else if (op === 13) {
        net.ledgerDown = r() < 0.4;
        net.readDown = r() < 0.4;
        log.push(`rpc down: ledger ${net.ledgerDown}, reads ${net.readDown}`);
      } else if (op === 14) {
        // Odd values in this browser's storage, left only where no write can still land.
        if (writes.some((w) => mayStillLand(w)) || local.has(`caracal.split.write.${SPLIT}`)) continue;
        const odd = ["garbage", '{"v":1,"until":123}', '{"v":2,"id":"x","closeBy":99999999999}', "null", "[]", '{"v":2,"id":5,"closeBy":9}'][Math.floor(r() * 6)]!;
        local.set(`caracal.split.write.${SPLIT}`, odd);
        if (r() < 0.3) local.set(`caracal.split.readAfter.${SPLIT}`, ["abc", "-5", "1.5", "99999999999", "null"][Math.floor(r() * 5)]!);
        log.push(`storage holds ${odd}`);
      } else if (op === 10) {
        refuse.after = r() < 0.4;
        refuse.remove = r() < 0.3;
        log.push(`storage refuses: ${JSON.stringify(refuse)}`);
      } else if (op === 11) {
        if (r() < 0.7) continue;
        // A reload of the page's tab: its locks go with it, its sent writes stay out there and may still land, a new
        // kit, new module state, the same storage.
        inst.dead = true;
        inst.cleanups.forEach((c) => c?.());
        for (const [name, o] of [...held]) if (o.actor === "tab1") held.delete(name);
        for (const w of writes) if (w.who === "page" && !w.ended) w.orphan = true;
        kit = makeKit();
        vi.resetModules();
        mod = await import("../src/app/split/page");
        clickShown = null;
        openPage();
        stats.reloads++;
        log.push("reload");
        await advance(1_500);
      } else if (op === 9 || op === 12) {
        const open = tab2Writes.filter((t) => !t.w.ended);
        if (open.length === 0) continue;
        const t = open[Math.floor(r() * open.length)]!;
        const k = r();
        if (k < 0.35) {
          land(t.w);
          if (t.w.landedAt !== null) {
            log.push(`tab2 write ${t.w.id} done`);
            t.guard.finish({ kind: "done", hash: "b".repeat(64), ledger: r() < 0.7 ? t.w.landedAt : undefined });
            t.w.ended = true;
            external = Date.now();
          }
        } else if (k < 0.55 && t.w.landedAt === null) {
          log.push(`tab2 write ${t.w.id} refused`);
          t.w.neverLands = true;
          t.guard.finish({ kind: "refused", message: "Nothing was sent" });
          t.w.ended = true;
          external = Date.now();
        } else {
          log.push(`tab2 write ${t.w.id} unknown`);
          t.guard.finish({ kind: "unknown", message: "no answer" });
          // it may still land; the record stays; its lock is let go
        }
      }
      // 2. whatever the page shows with Withdraw offered includes every write that went through
      if (withdrawEnabled() && Date.now() - external > 6_000) {
        const shown = shownSpend();
        stats.offered++;
        const maybe = writes.some((w) => mayStillLand(w));
        const real = START_SPEND - ONE * BigInt(landed().length);
        if (shown !== null && shown !== real) violations.push(`seed ${seed}: Withdraw offered at ledger ${net.ledger} on pots showing ${shown}, the chain holds ${real}: ${log.slice(-12).join(" | ")}`);
        if (maybe) violations.push(`seed ${seed}: Withdraw offered at ledger ${net.ledger} while a write may still land: ${log.slice(-12).join(" | ")}`);
      }
      if (violations.length > 0) break;
    }
    if (violations.length === 0) {
      // Liveness: end every write, make the network healthy, wait 12 minutes: Withdraw must be offered again.
      for (const w of writes) {
        if (!w.ended && w.who === "page" && !w.orphan && w.settle) {
          w.neverLands = w.landedAt === null ? true : w.neverLands;
          w.settle({ success: false, error: Object.assign(new Error("The fee relayer refused this transaction (POOL_CAPACITY). Nothing was sent."), { name: "Error" }) });
          w.ended = true;
        }
      }
      for (const t of tab2Writes) if (!t.w.ended) t.guard.finish({ kind: "refused", message: "Nothing was sent" });
      for (const w of writes) if (w.landedAt === null) w.neverLands = true;
      refuse.after = false;
      refuse.remove = false;
      net.lagLedger = 0;
      net.lagRead = 0;
      net.readMs = 10;
      net.ledgerDown = false;
      net.readDown = false;
      await advance(3 * 60_000);
      // The ways forward the page itself offers: Try again after a failed read, then, for odd storage that holds every
      // write, "I have checked the pots", then Refresh.
      for (let round = 0; round < 3; round++) {
        const again = button(inst.tree, "Try again");
        if (again) {
          log.push("press Try again");
          again.props!.onClick!();
          await advance(3_000);
        }
        const checked = button(inst.tree, "I have checked the pots");
        if (checked) {
          log.push("press I have checked the pots");
          checked.props!.onClick!();
          await advance(3_000);
        }
        await advance(3 * 60_000);
      }
      const refresh = button(inst.tree, "Refresh");
      if (refresh && !withdrawEnabled()) {
        log.push("press Refresh");
        refresh.props!.onClick!();
        await advance(3_000);
      }
      await advance(6 * 60_000);
      stats.lived++;
      if (!withdrawEnabled()) violations.push(`seed ${seed}: 12 minutes (and the person's check or Refresh) after every write ended, Withdraw is still not offered (disabled ${String(button(inst.tree, "Withdraw with my passkey")?.props?.disabled)}; storage ${JSON.stringify([...local])}; ledger ${net.ledger}): ${text().slice(-700)} | ${log.slice(-14).join(" | ")}`);
    }
  } finally {
    clearInterval(tick);
    if (navDesc) Object.defineProperty(globalThis.navigator, "locks", navDesc);
    inst.dead = true;
    inst.cleanups.forEach((c) => c?.());
  }
  return violations;
}

describe("adversary s25: the split page against a fake chain, a lagging RPC and a second tab", () => {
  it("never sends a write while another may still land or on pots that miss a write that went through, and is not stuck once all writes ended", async () => {
    const all: string[] = [];
    for (let seed = Number(process.env.S25_FROM ?? 1); seed <= Number(process.env.S25_SEEDS ?? 60) && all.length < 3; seed++) {
      all.push(...(await run(seed, Number(process.env.S25_STEPS ?? 45))));
    }
    console.log(JSON.stringify(stats));
    expect(all).toEqual([]);
  }, 600_000);
});
