// Adversary r4b. Promise (apps/web/.env.example, NEXT_PUBLIC_STELLAR_RPC_URL;
// kit.ts HTTPS_RPC_REQUIRED): the browser wallet needs an https RPC, and "says
// so" only when the URL is not https. A URL scheme is case-insensitive, and
// both stellar-sdk (which smart-account-kit 0.10.0 uses for its RPC) and the
// relay accept "HTTPS://...". The wallet page must not tell the person to set
// "an https address" when they already have one.
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("smart-account-kit");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getKit with an upper-case https scheme in NEXT_PUBLIC_STELLAR_RPC_URL", () => {
  it("is not refused as 'not https'", async () => {
    const url = "HTTPS://soroban-testnet.stellar.org";
    // The same constructor call smart-account-kit makes (kit.js: new RpcServer(config.rpcUrl)):
    // this URL is a valid https RPC address, not an insecure one.
    expect(() => new rpc.Server(url)).not.toThrow();

    vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", url);
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
    vi.doMock("smart-account-kit", () => ({ SmartAccountKit: class { kind = "kit"; }, IndexedDBStorage: class {} }));
    vi.resetModules(); // the setup file already loaded stellar/config with the default URL
    const { getKit } = await import("../src/lib/stellar/kit");
    await expect(getKit()).resolves.toMatchObject({ kind: "kit" });
  });
});
