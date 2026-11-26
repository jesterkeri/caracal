// Adversary r3c: sign-in setup paths.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("adv r3c: auth", () => {
  it("callback with an unusable Supabase URL sends the person to /signin?error=config instead of throwing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://<project-ref>.supabase.co"); // the .env.example line, uncommented unedited
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    vi.doMock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
    const { GET } = await import("../src/app/auth/callback/route");
    const r = await GET(new Request("http://localhost:3000/auth/callback?code=abc"));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe("/signin");
  });
});
