// Adversary r3b follow-up: when Supabase cannot be reached, signing out still
// ends the session in this browser (local sign-out removes it before any
// network call), using the real supabase-js client.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { bindWallet, endSupabaseSession, signOutEverywhere, WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// A structurally valid, unsigned test token for a made-up user. Never a real credential.
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "user-A", exp, aud: "authenticated", role: "authenticated" })}.sig`;
function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
function signedInClient(fetchImpl: typeof fetch) {
  const authStorage = memoryStore();
  const client = createClient("https://example.supabase.co", "anon-test-key", {
    auth: { storage: authStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
  const far = Math.floor(Date.now() / 1000) + 3600;
  authStorage.setItem(
    "sb-example-auth-token",
    JSON.stringify({ access_token: jwt(far), refresh_token: "refresh-test", expires_at: far, expires_in: 3600, token_type: "bearer", user: { id: "user-A", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-26T00:00:00Z" } }),
  );
  return client;
}

describe("sign-out when Supabase cannot be reached", () => {
  it("offline: the session still ends in this browser and sign-out resolves", async () => {
    const client = signedInClient((async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    expect((await client.auth.getSession()).data.session).not.toBeNull();
    const store = memoryStore();
    bindWallet(store, "user-A");
    const kit = { disconnect: vi.fn(async () => {}) };
    await signOutEverywhere(store, kit, () => endSupabaseSession(client.auth));
    expect((await client.auth.getSession()).data.session).toBeNull();
    expect(kit.disconnect).toHaveBeenCalled();
    expect(store.getItem(WALLET_OWNER_KEY)).toBeNull();
  });

  it("server error (500): same", async () => {
    const client = signedInClient((async () => new Response("{}", { status: 500 })) as typeof fetch);
    await signOutEverywhere(memoryStore(), { disconnect: async () => {} }, () => endSupabaseSession(client.auth));
    expect((await client.auth.getSession()).data.session).toBeNull();
  });

  it("if the session somehow survives, sign-out rejects instead of claiming success", async () => {
    const auth = {
      signOut: vi.fn(async () => ({ error: new Error("offline") })),
      getSession: async () => ({ data: { session: { user: "A" } } }),
    };
    await expect(signOutEverywhere(memoryStore(), { disconnect: async () => {} }, () => endSupabaseSession(auth))).rejects.toThrow(/Sign-out did not finish/);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
