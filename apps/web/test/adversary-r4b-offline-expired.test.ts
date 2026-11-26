// Adversary r4b. Promise (docs/decisions.md, r3k row; account.ts SignInState):
// "Sign out stays offered when the session cannot be verified (a stored session
// on /signin; an error on /wallet)", and "unverified: a session is stored in
// this browser, but Supabase could not confirm it (unreachable, or it refused
// the session)". Only "signed-out" means "no session in this browser".
//
// The common way to reach this is an access token that has expired (they last
// an hour) while Supabase cannot be reached. supabase-js then cannot refresh,
// and getSession() answers { session: null } although the expired session and
// its refresh token are still in storage (auth-js 2.119.2, GoTrueClient
// __loadSession: a failed refresh with an expired stored session returns
// session: null). readSignInState read that as "no session in this browser".
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSignInState } from "../src/lib/auth/account";
import { fetchWithTimeout } from "../src/lib/supabase/client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// A structurally valid, unsigned test token for a made-up user. Never a real credential.
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "user-A", exp, aud: "authenticated", role: "authenticated" })}.sig`;
const KEY = "sb-example-auth-token";

function storedExpiredSession() {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  const client = createClient("https://example.supabase.co", "anon-test-key", {
    auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchWithTimeout },
  });
  const expired = Math.floor(Date.now() / 1000) - 2 * 3600; // signed in two hours ago
  storage.setItem(
    KEY,
    JSON.stringify({ access_token: jwt(expired), refresh_token: "refresh-test", expires_at: expired, expires_in: 3600, token_type: "bearer", user: { id: "user-A", email: "a@x.ng", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-26T00:00:00Z" } }),
  );
  return { client, storage };
}

describe("a stored session whose access token expired, with Supabase unreachable", () => {
  it("is 'unverified' (sign-out offered), not 'signed-out', because the session is still stored", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const { client, storage } = storedExpiredSession();

    const pending = readSignInState(client.auth);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // supabase-js retries its refresh for up to 30 s, twice
    const state = await pending;

    // The session (and its refresh token) is still in this browser...
    expect(storage.getItem(KEY)).not.toBeNull();
    // ...so the page must not call it "no session in this browser": that hides Sign out
    // (/signin shows Continue with Google, /wallet redirects there) on a shared browser.
    expect(state.kind).toBe("unverified");
  });
});
