import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("adv r2g relay", () => {
  it(".env.example says NEXT_PUBLIC_STELLAR_RPC_URL is an optional override: an http RPC (local quickstart) must not crash the route at import", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "http://localhost:8000/rpc");
    const mod = await import("../src/app/api/relay/route");
    expect(typeof mod.POST).toBe("function");
  });
});
