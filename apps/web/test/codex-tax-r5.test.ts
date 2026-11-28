// Codex tax R5 (REVISE, 1 finding): POST /tax/estimate read the request body before its 100 s deadline started, and
// readBounded waited for the next chunk for ever, deaf to the caller going away, so a body that stalled held the
// route past the deadline and after the caller cancelled. Now the deadline starts first, the body read stops at the
// deadline or the caller's abort, and the body stream is cancelled. The byte limit is kept.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBounded } from "../src/lib/relay/policy";
import { ESTIMATE_DEADLINE_MS } from "../src/lib/tax/deadline";

/** A request whose body sends a first chunk and then nothing, and records whether its stream was cancelled. */
function stalledRequest(signal?: AbortSignal) {
  const seen = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"wallet":'));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  const request = new Request("http://localhost/tax/estimate", { method: "POST", body: stream, headers: { "content-type": "application/json" }, signal, duplex: "half" } as RequestInit);
  return { request, seen };
}

async function route() {
  vi.resetModules(); // a fresh copy of the route, with fresh limits
  return (await import("../src/app/tax/estimate/route")).POST;
}

/** Whether a promise has settled within the fake time given. */
async function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return done;
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Codex tax R5: a stalled request body is bounded by the deadline and by the caller", () => {
  it("control: a whole body is read, and one past the byte limit is refused", async () => {
    const ok = new Request("http://localhost/x", { method: "POST", body: "abc" });
    await expect(readBounded(ok, 10, new AbortController().signal)).resolves.toBe("abc");
    const big = new Request("http://localhost/x", { method: "POST", body: "x".repeat(20) });
    await expect(readBounded(big, 10, new AbortController().signal)).resolves.toBeNull();
  });

  it("the route answers at its deadline when the body stalls, with no number, and cancels the body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const POST = await route();
    const { request, seen } = stalledRequest();
    const pending = POST(request);
    expect(await settledWithin(pending, ESTIMATE_DEADLINE_MS + 1_000)).toBe(true);
    const out = (await (await pending).json()) as { status?: string; message?: string; disclaimer?: string };
    expect(out.status).toBe("unavailable");
    expect(out.message).toMatch(/took longer than 100 seconds/);
    expect(out.disclaimer).toMatch(/estimate, not tax advice/);
    expect(seen.cancelled).toBe(true);
  });

  it("the route stops when the caller goes away while the body stalls, and cancels the body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const POST = await route();
    const caller = new AbortController();
    const { request, seen } = stalledRequest(caller.signal);
    const pending = POST(request);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    expect(await settledWithin(pending, 1_000)).toBe(true);
    const res = await pending;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cancelled before the estimate finished/);
    expect(seen.cancelled).toBe(true);
  });
});
