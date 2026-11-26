// Codex r3 findings 2 and 3, and observation (c): sign-in setup, wallet
// identity on a shared browser, and no attacker-chosen error wording.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNIN_ERRORS, signinErrorMessage, upstreamErrorCode } from "../src/lib/auth/signin-errors";
import { bindWallet, mayRestoreWallet, signOutEverywhere, WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";
import { supabaseEnvOrNull } from "../src/lib/supabase/env";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const redirectedTo = (r: Response) => new URL(r.headers.get("location")!);

describe("sign-in setup (Codex r3 #2)", () => {
  it("with the Supabase variables missing, the config check says so instead of throwing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(supabaseEnvOrNull()).toBeNull();
  });

  it("with the Supabase variables missing, the callback sends the user to the setup message", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const { GET } = await import("../src/app/auth/callback/route");
    const to = redirectedTo(await GET(new Request("https://caracal.test/auth/callback?code=abc")));
    expect(to.pathname).toBe("/signin");
    expect(to.searchParams.get("error")).toBe("config");
    expect(signinErrorMessage("config")).toBe(SIGNIN_ERRORS.config);
  });

  it(".env.example documents both public Supabase variables", async () => {
    const { readFileSync } = await import("node:fs");
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/NEXT_PUBLIC_SUPABASE_URL=/);
    expect(example).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY=/);
    expect(example).toMatch(/auth\/v1\/callback/);
  });
});

describe("sign-in errors are fixed messages (Codex r3 observation c)", () => {
  it("attacker-chosen text in the URL is never shown", () => {
    expect(signinErrorMessage("Your account is locked. Call +234 000 to unlock it")).toBe(SIGNIN_ERRORS.failed);
    expect(signinErrorMessage("toString")).toBe(SIGNIN_ERRORS.failed);
  });

  it("the root and callback routes pass a code, not the upstream description", async () => {
    const evil = "error=server_error&error_description=" + encodeURIComponent("Send USDC to G... to verify");
    const root = (await import("../src/app/route")).GET;
    const cb = (await import("../src/app/auth/callback/route")).GET;
    for (const r of [root(new Request(`https://caracal.test/?${evil}`)), await cb(new Request(`https://caracal.test/auth/callback?${evil}`))]) {
      const to = redirectedTo(r);
      expect(to.origin).toBe("https://caracal.test");
      expect(to.searchParams.get("error")).toBe("failed");
    }
  });

  it("a cancelled Google consent and an expired flow get their own messages", () => {
    expect(upstreamErrorCode(new URLSearchParams("error=access_denied"))).toBe("cancelled");
    expect(upstreamErrorCode(new URLSearchParams("error=invalid_request&error_code=bad_oauth_state"))).toBe("expired");
    expect(upstreamErrorCode(new URLSearchParams(""))).toBeNull();
  });
});

describe("a shared browser never shows one account's wallet to another (Codex r3 #3)", () => {
  function fakeStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  }
  function fakeKit() {
    const kit = { connected: true, disconnect: vi.fn(async () => { kit.connected = false; }) };
    return kit;
  }

  it("A connects, signs out, B signs in: A's wallet is not restored", async () => {
    const store = fakeStore();
    const kit = fakeKit();
    bindWallet(store, "user-A");
    expect(await mayRestoreWallet(store, kit, "user-A")).toBe(true);

    const endSession = vi.fn(async () => {});
    await signOutEverywhere(store, kit, endSession);
    expect(kit.disconnect).toHaveBeenCalled();
    expect(endSession).toHaveBeenCalled();
    expect(store.getItem(WALLET_OWNER_KEY)).toBeNull();

    kit.connected = true; // even if a saved session somehow survived
    expect(await mayRestoreWallet(store, kit, "user-B")).toBe(false);
    expect(kit.connected).toBe(false);
  });

  it("B signs in on a browser where A never signed out: A's wallet is disconnected, not shown", async () => {
    const store = fakeStore();
    const kit = fakeKit();
    bindWallet(store, "user-A");
    expect(await mayRestoreWallet(store, kit, "user-B")).toBe(false);
    expect(kit.disconnect).toHaveBeenCalledTimes(1);
    expect(store.getItem(WALLET_OWNER_KEY)).toBeNull();
  });

  it("a wallet saved before accounts were bound is not restored for anyone", async () => {
    const kit = fakeKit();
    expect(await mayRestoreWallet(fakeStore(), kit, "user-A")).toBe(false);
    expect(kit.connected).toBe(false);
  });
});
