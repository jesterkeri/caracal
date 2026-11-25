import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("adv r2f relay route", () => {
  it("a request body that errors mid-stream still gets the documented JSON answer, not an unhandled throw", async () => {
    const { POST } = await import("../src/app/api/relay/route");
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent) throw new Error("client reset");
        sent = true;
        c.enqueue(new TextEncoder().encode('{"func":'));
      },
    });
    const req = new Request("http://x/api/relay", { method: "POST", body, duplex: "half" } as RequestInit);
    let r: Response;
    try { r = await POST(req); } catch (e) { throw new Error("POST() rejected instead of answering JSON: " + (e as Error).message); }
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await r.json()).success).toBe(false);
  });
});
