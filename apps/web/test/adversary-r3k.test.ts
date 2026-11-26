// Adversary r3k: an odd NEXT_PUBLIC_SUPABASE_URL that supabaseEnvOrNull accepts
// but supabase-js refuses.
//
// Promise broken: docs/decisions.md 2026-11-26 (r3c): "An unusable ... Supabase
// URL gives the documented 'not set up' answer instead of a crash", and
// src/lib/supabase/env.ts: "Null unless both are set and the URL is one
// supabase-js accepts (an http or https URL)".
//
// supabaseEnvOrNull checks `new URL(url).protocol`, which accepts "https:host"
// (no slashes; WHATWG parsing treats it as https://host). supabase-js requires
// the text to start with `http://` or `https://` and throws otherwise, so the
// callback route rejects (HTTP 500) instead of sending the person to
// /signin?error=config, and /signin throws in its effect.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

// Each of these parses as an https or http URL with `new URL` but has no "//" after the scheme.
const ODD_URLS = ["https:abc.supabase.co", "http:abc.supabase.co"];

describe("adv r3k: a Supabase URL that new URL accepts and supabase-js refuses", () => {
  it("control: supabase-js really refuses these values (so the env check must too)", async () => {
    const { createServerClient } = await import("@supabase/ssr");
    for (const u of ODD_URLS) {
      expect(new URL(u).protocol).toMatch(/^https?:$/);
      expect(() => createServerClient(u, "anon-test-key", { cookies: { getAll: () => [], setAll() {} } })).toThrow(/Invalid supabaseUrl/);
    }
  });

  for (const u of ODD_URLS) {
    it(`supabaseEnvOrNull treats ${u} as not set up`, async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", u);
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
      const { supabaseEnvOrNull } = await import("../src/lib/supabase/env");
      expect(supabaseEnvOrNull()).toBeNull();
    });

    it(`callback with ${u} sends the person to /signin?error=config instead of throwing`, async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", u);
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
      vi.doMock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
      const { GET } = await import("../src/app/auth/callback/route");
      const r = await GET(new Request("http://localhost:3000/auth/callback?code=abc"));
      expect(r.status).toBe(307);
      expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("config");
    });
  }
});

describe("adv r3k: the /signin page with such a URL", () => {
  it("does not throw in its effect (the person should see the 'not set up' message)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https:abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    vi.stubGlobal("window", { location: { search: "", origin: "https://caracal.test" } });
    const effects: (() => unknown)[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        default: actual,
        useState: (init: unknown) => [init, () => {}],
        useEffect: (fn: () => unknown) => void effects.push(fn),
      };
    });
    const mod = await import("../src/app/signin/page");
    mod.default();
    expect(effects).toHaveLength(1);
    // The page treats this URL as configured, so its effect builds a Supabase client, which throws.
    expect(() => effects[0]!()).not.toThrow();
    vi.doUnmock("react");
    vi.unstubAllGlobals();
  });
});
