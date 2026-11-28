// Codex tax R6 (REVISE, 1 finding, P2): readBounded stopped waiting for a stalled body at the deadline, but then
// awaited reader.cancel() with no deadline, so a stream whose cancellation never settles still held the estimate
// past 100 s. The over-limit path did the same. Now the cancellation is started and not waited for, on every path
// (the deadline, the caller going away, a body past the byte limit), and the same holds for readLimitedText, which
// reads the CBN and RPC answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBounded } from "../src/lib/relay/policy";
import { readLimitedText } from "../src/lib/tax/read-limited";
import { ESTIMATE_DEADLINE_MS } from "../src/lib/tax/deadline";

/** A body that sends `first` and then nothing, and whose cancel() never settles. */
function hangingStream(first: string) {
  const seen = { cancelCalled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(first));
    },
    cancel() {
      seen.cancelCalled = true;
      return new Promise<void>(() => {}); // never settles
    },
  });
  return { stream, seen };
}

function hangingRequest(first: string, signal?: AbortSignal) {
  const { stream, seen } = hangingStream(first);
  const request = new Request("http://localhost/tax/estimate", { method: "POST", body: stream, headers: { "content-type": "application/json" }, signal, duplex: "half" } as RequestInit);
  return { request, seen };
}

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
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Codex tax R6: a body whose cancellation never settles does not hold the read", () => {
  it("readBounded ends at the abort although cancel() never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { request, seen } = hangingRequest('{"wallet":');
    const ac = new AbortController();
    const pending = readBounded(request, 1_000, ac.signal);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort(new Error("deadline"));
    expect(await settledWithin(pending, 1_000)).toBe(true);
    await expect(pending).rejects.toThrow("deadline");
    expect(seen.cancelCalled).toBe(true);
  });

  it("readBounded refuses a body past the byte limit although cancel() never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { request, seen } = hangingRequest("x".repeat(50));
    const pending = readBounded(request, 10, new AbortController().signal);
    expect(await settledWithin(pending, 1_000)).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(seen.cancelCalled).toBe(true);
  });

  it("the estimate route answers at its deadline although the stalled body's cancel() never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const POST = (await import("../src/app/tax/estimate/route")).POST;
    const { request, seen } = hangingRequest('{"wallet":');
    const pending = POST(request);
    expect(await settledWithin(pending, ESTIMATE_DEADLINE_MS + 1_000)).toBe(true);
    const out = (await (await pending).json()) as { status?: string; message?: string };
    expect(out.status).toBe("unavailable");
    expect(out.message).toMatch(/took longer than 100 seconds/);
    expect(seen.cancelCalled).toBe(true);
  });

  it("readLimitedText refuses an answer past its limit although cancel() never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stream, seen } = hangingStream("x".repeat(50));
    const pending = readLimitedText(new Response(stream), 10);
    expect(await settledWithin(pending, 1_000)).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(seen.cancelCalled).toBe(true);
  });

  it("readLimitedText refuses a declared length past its limit although cancel() never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stream, seen } = hangingStream("x");
    const pending = readLimitedText(new Response(stream, { headers: { "content-length": "999" } }), 10);
    expect(await settledWithin(pending, 1_000)).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(seen.cancelCalled).toBe(true);
  });
});
