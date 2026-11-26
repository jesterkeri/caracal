// Adversary r3g: .env.example promised a local http RPC works, but the browser
// wallet kit (smart-account-kit 0.10.0) refuses http with no way to allow it,
// and the page showed the SDK's raw error. Changed expectation (recorded in
// docs/decisions.md): the documented rule is now "https for the wallet", and an
// http RPC gives a clear message naming the setting instead of a raw error.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("adv r3g: wallet kit with an http RPC", () => {
  for (const url of ["http://localhost:8000/soroban/rpc", "http://127.0.0.1:8000/soroban/rpc", "http://[::1]:8000/soroban/rpc", "http://rpc.example.com"]) {
    it(`getKit() with NEXT_PUBLIC_STELLAR_RPC_URL=${url} says which setting to fix`, async () => {
      vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", url);
      vi.resetModules(); // the test setup already loaded config; reload it with the stubbed URL
      vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
      const { getKit, HTTPS_RPC_REQUIRED } = await import("../src/lib/stellar/kit");
      await expect(getKit()).rejects.toThrow(HTTPS_RPC_REQUIRED);
      expect(HTTPS_RPC_REQUIRED).toMatch(/NEXT_PUBLIC_STELLAR_RPC_URL/);
    });
  }
  it("the https default builds the kit", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
    vi.doMock("smart-account-kit", () => ({ SmartAccountKit: class { ok = true; }, IndexedDBStorage: class {} }));
    const { getKit } = await import("../src/lib/stellar/kit");
    await expect(getKit()).resolves.toMatchObject({ ok: true });
    vi.doUnmock("smart-account-kit");
  });
});
