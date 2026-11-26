// Adversary r3i.
//
// 1. Time: a clock that runs backwards.
//    src/lib/relay/policy.ts WindowLimiter is a fixed 60 s window keyed on
//    Date.now(). If the wall clock steps back (an NTP correction, a VM or laptop
//    resumed from a snapshot), a window whose start is now "in the future" never
//    expires until the clock catches up again, so a key that hit its limit stays
//    blocked for the length of the step plus the window. The relay's one global
//    "all" key then refuses every request for that long.
//
// 2. Sign-out when the Supabase revoke request never answers (a captive portal,
//    a blackholed route). src/lib/auth/wallet-binding.ts endSupabaseSession
//    says it "Tries to revoke it everywhere first; if that fails (offline,
//    server error) ... falls back to signing out this browser only", and
//    docs/decisions.md (2026-11-26, r3b) says sign-out "falls back to ending the
//    session in this browser only when Supabase cannot be reached". A request
//    that hangs is the same as one that cannot be reached, but the fallback only
//    runs when the first call resolves with an error, and only the wallet
//    disconnect has a time bound, so the person is left on a button that never
//    finishes and the session is never ended.
import { afterEach, describe, expect, it, vi } from "vitest";
import { endSupabaseSession, mayRestoreWallet, signOutEverywhere, type SessionAuth } from "../src/lib/auth/wallet-binding";
import { WindowLimiter } from "../src/lib/relay/policy";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("adv r3i: the rate limiter after the clock steps back", () => {
  it("a full window ends 60 s after it started, even if the clock was set back meanwhile", () => {
    const limiter = new WindowLimiter(2, 60_000);
    const t0 = 1_800_000_000_000;
    expect(limiter.take("k", t0)).toBe(true);
    expect(limiter.take("k", t0)).toBe(true);
    expect(limiter.take("k", t0)).toBe(false); // over the limit, as intended
    // The clock is corrected 10 minutes backwards; a minute and a bit later in
    // the corrected timeline the caller has waited longer than the window.
    const stepBack = 10 * 60_000;
    const later = t0 - stepBack + 61_000;
    expect(limiter.take("k", later)).toBe(true);
  });

  it("route: after the clock steps back 10 minutes, a full minute later /api/relay serves again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-26T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { POST } = await import("../src/app/api/relay/route");
    const call = () => POST(new Request("https://caracal.test/api/relay", { method: "POST", body: "not json" }));
    // Burn the shared (untrusted proxy) bucket of 10 per minute.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call()).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    // The clock is set back 10 minutes, then a full minute passes.
    vi.setSystemTime(t0 - 10 * 60_000 + 61_000);
    expect((await call()).status).toBe(400); // a fresh window: answered (bad body), not rate limited
  });
});

// 3. src/lib/auth/wallet-binding.ts mayRestoreWallet: "Otherwise the saved
//    session is disconnected and forgotten." When the browser refuses
//    localStorage.removeItem (blocked or full storage), the throw escapes
//    before the disconnect, so the previous person's wallet session is left
//    in the kit's storage. signOutEverywhere guards the same call; this one
//    does not.
describe("adv r3i: restoring a wallet for another account when localStorage refuses removeItem", () => {
  it("still disconnects the previous person's saved wallet and refuses to restore it", async () => {
    const disconnect = vi.fn(async () => {});
    const store = {
      getItem: () => "user-A",
      setItem: () => {},
      removeItem: () => {
        throw new DOMException("storage is blocked", "SecurityError");
      },
    };
    const outcome = await mayRestoreWallet(store, { disconnect }, "user-B").then(
      (v) => `resolved:${v}`,
      (e: unknown) => `rejected:${e instanceof Error ? e.name : String(e)}`,
    );
    expect({ outcome, disconnected: disconnect.mock.calls.length }).toEqual({ outcome: "resolved:false", disconnected: 1 });
  });
});

describe("adv r3i: sign-out when the revoke request hangs", () => {
  it("still ends the session in this browser within two minutes", async () => {
    vi.useFakeTimers();
    let session: unknown = { user: "A" };
    const calls: string[] = [];
    const auth: SessionAuth = {
      // global revoke: the network never answers. local: removes the session before any network call.
      signOut: (opts) => {
        calls.push(opts?.scope ?? "global");
        if (opts?.scope === "local") {
          session = null;
          return Promise.resolve({ error: null });
        }
        return new Promise(() => {});
      },
      getSession: async () => ({ data: { session } }),
    };
    const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    let settled = "pending" as "pending" | "resolved" | "rejected";
    void signOutEverywhere(store, { disconnect: async () => {} }, () => endSupabaseSession(auth)).then(
      () => (settled = "resolved"),
      () => (settled = "rejected"),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    // Either the session was ended locally or the caller was told it failed. Never silence.
    expect(settled, `calls so far: ${calls.join(", ")}; session still stored: ${session !== null}`).not.toBe("pending");
    expect(settled === "rejected" || session === null).toBe(true);
  });
});
