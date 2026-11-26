// Adversary r3b: sign-out when the Supabase revoke request fails (offline, 5xx).
// supabase-js signOut() does not throw: it resolves { error } and, for the
// default "global" scope, leaves the session in storage. wallet-binding.ts
// documents "The session always ends", but ignores that result, so the page
// redirects to /signin as if signed out while the next visitor on a shared
// browser is still signed in as the previous person.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { bindWallet, signOutEverywhere } from "../src/lib/auth/wallet-binding";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// A structurally valid, unsigned test token for a made-up user. Never a real credential.
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "user-A", exp, aud: "authenticated", role: "authenticated" })}.sig`;

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("adv r3b sign-out", () => {
  it("when Supabase cannot be reached, sign-out does not resolve as if it had worked while the session survives", async () => {
    const authStorage = memoryStore();
    const client = createClient("https://example.supabase.co", "anon-test-key", {
      auth: { storage: authStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch },
    });
    const far = Math.floor(Date.now() / 1000) + 3600;
    authStorage.setItem(
      "sb-example-auth-token",
      JSON.stringify({ access_token: jwt(far), refresh_token: "refresh-test", expires_at: far, expires_in: 3600, token_type: "bearer", user: { id: "user-A", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-26T00:00:00Z" } }),
    );
    expect((await client.auth.getSession()).data.session).not.toBeNull();

    const store = memoryStore();
    bindWallet(store, "user-A");
    const kit = { disconnect: vi.fn(async () => {}) };
    const outcome = await signOutEverywhere(store, kit, () => client.auth.signOut()).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    const stillSignedIn = (await client.auth.getSession()).data.session !== null;
    // Acceptable: the session really ended, or the caller was told it failed.
    expect(outcome === "rejected" || !stillSignedIn).toBe(true);
  });
});
