// Adversary r3c suspicion: one failed load of the wallet kit must not break
// the wallet page and sign-out's disconnect until the page is reloaded.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("smart-account-kit");
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getKit after a failed load", () => {
  it("tries again on the next call", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
    let loads = 0;
    vi.doMock("smart-account-kit", () => {
      loads += 1;
      if (loads === 1) throw new Error("ChunkLoadError: loading chunk failed");
      return { SmartAccountKit: class { kind = "kit"; }, IndexedDBStorage: class {} };
    });
    const { getKit } = await import("../src/lib/stellar/kit");
    await expect(getKit()).rejects.toThrow(); // vitest wraps the factory error
    vi.resetModules(); // a fresh import() of the kit module, as the browser would refetch the chunk
    await expect(getKit()).resolves.toMatchObject({ kind: "kit" });
  });
});
