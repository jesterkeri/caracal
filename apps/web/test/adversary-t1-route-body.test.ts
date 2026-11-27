// Adversary t1: POST /tax/estimate takes no sign-in, and it reads the whole
// request body into memory before it checks the 2,000 character limit
// (apps/web/src/app/tax/estimate/route.ts: `await request.text()` first). The
// repo's own `readBounded` (src/lib/relay/policy.ts) stops reading at its limit.
import { describe, expect, it } from "vitest";
import { POST } from "../src/app/tax/estimate/route";

/** A request whose body is a stream of 64 KiB chunks, `total` chunks long, counting what the server pulled. */
function streamed(total: number) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= total) return c.close();
      pulled++;
      c.enqueue(chunk);
    },
  });
  const request = new Request("http://localhost/tax/estimate", { method: "POST", body, duplex: "half" } as RequestInit);
  return { request, pulledBytes: () => pulled * chunk.length };
}

describe("adversary t1: unbounded request body", () => {
  // Control changed after the fix (disclosed in docs/decisions.md): it asserted the old
  // behaviour, that the whole 640 KiB body is read before the refusal. It now checks
  // what the harness is for: the stream is pulled and counted, and the route refuses.
  it("control: a 10-chunk (640 KiB) body is pulled (and counted) and refused as too large", async () => {
    const s = streamed(10);
    const res = await POST(s.request);
    expect(res.status).toBe(400);
    expect(s.pulledBytes()).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("stops reading a body that is far over the limit instead of reading all 64 MiB", async () => {
    const s = streamed(1024);
    const res = await POST(s.request);
    expect(res.status).toBe(400);
    // The relay's bound is 64 KiB; allow a few chunks of read-ahead.
    expect(s.pulledBytes()).toBeLessThanOrEqual(1024 * 1024);
  });
});
