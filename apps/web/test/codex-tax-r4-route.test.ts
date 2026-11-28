// Codex tax R4 #2 (2026-11-28): POST /tax/estimate takes no sign-in, had no overall deadline or request limit, and
// did not pass on the caller going away, so a caller could start expensive multi-page reads that went on after the
// page stopped waiting. Now one estimate has a 100 s deadline, the deadline and the caller's abort both abort every
// network read it makes, and a per-process limit refuses bursts (a shared quota comes with the database, before a
// public deploy: docs/fix-day.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESTIMATE_DEADLINE_MS } from "../src/lib/tax/deadline";
import { WALLET } from "./adversary-t1-harness";

const body = JSON.stringify({ wallet: WALLET, otherIncome: { kind: "all-in-caracal" } });
const ask = (signal?: AbortSignal) => new Request("http://localhost/tax/estimate", { method: "POST", body, headers: { "content-type": "application/json" }, signal });

/** A network that never answers, and records whether each read it was given has been aborted. */
function silentNetwork() {
  const reads: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_u: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      reads.push(signal);
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }),
  );
  return reads;
}

async function route() {
  vi.resetModules(); // a fresh copy of the route, with fresh limits
  return (await import("../src/app/tax/estimate/route")).POST;
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Codex tax R4 #2: the public estimate route is bounded", () => {
  it("stops at its deadline, aborts the read in flight, and says so with no number", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reads = silentNetwork();
    const POST = await route();
    const pending = POST(ask());
    await vi.advanceTimersByTimeAsync(10);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((s) => !s.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(ESTIMATE_DEADLINE_MS);
    const res = await pending;
    expect(reads.every((s) => s.aborted)).toBe(true);
    const out = (await res.json()) as { status: string; message: string; disclaimer: string };
    expect(out.status).toBe("unavailable");
    expect(out.message).toMatch(/took longer than 100 seconds, so Caracal stopped it\. No number was produced/);
    expect(out.disclaimer).toMatch(/estimate, not tax advice/);
    expect(JSON.stringify(out)).not.toMatch(/totalTaxNgn/);
  });

  it("the deadline is shorter than the page's own 2 minute wait, so the server answers first", () => {
    expect(ESTIMATE_DEADLINE_MS).toBeLessThan(120_000);
  });

  it("aborts the read in flight when the caller goes away", async () => {
    const reads = silentNetwork();
    const POST = await route();
    const caller = new AbortController();
    const pending = POST(ask(caller.signal));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads.length).toBeGreaterThan(0);
    caller.abort();
    const res = await pending;
    expect(reads.every((s) => s.aborted)).toBe(true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cancelled before the estimate finished\. No number was produced/);
  });

  it("refuses a burst from one address with 429, before any network read", async () => {
    const reads = silentNetwork();
    const POST = await route();
    const callers = Array.from({ length: 6 }, () => new AbortController());
    const running = callers.map((c) => POST(ask(c.signal)));
    await new Promise((r) => setTimeout(r, 20));
    const before = reads.length;
    const seventh = await POST(ask());
    expect(seventh.status).toBe(429);
    expect(((await seventh.json()) as { error: string }).error).toMatch(/Too many estimates/);
    expect(reads.length).toBe(before);
    callers.forEach((c) => c.abort());
    await Promise.all(running);
  });
});
