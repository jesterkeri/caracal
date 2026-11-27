// Adversary t2: the tax page waits for POST /tax/estimate with no limit.
//
// Goal 5 of this pass: "a page or request that hangs without bound". Every
// other page that waits on the network in this repo bounds the wait (the wallet
// page's 30 s restore, the receipt page's 20 s, supabase's 10 s deadline), and
// the server route itself can take minutes (up to 100 pages and 100 transaction
// lookups at 20 s each). The tax page calls fetch() with no AbortSignal and no
// timer, so a server that accepts the request and never answers leaves
// "Working it out..." with the button disabled until the person reloads: the
// page's own FAILED message ("Check your connection and try again") can never
// appear for that failure.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanUp, mountTaxPage, walk } from "./adversary-t2-page-harness";

afterEach(() => {
  vi.restoreAllMocks();
  cleanUp();
});

async function startEstimate(fetchStub: (url: string, init: { body: string; signal?: AbortSignal }) => Promise<Response>) {
  const { render, settle } = await mountTaxPage(fetchStub as never);
  (walk(render(), (e) => e.type === "input" && e.props.type === "radio")[0]!.props.onChange as () => void)();
  const timers: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    timers.push(Number(ms ?? 0));
    return realSetTimeout(fn, ms, ...a);
  }) as never);
  const signalTimeouts: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    signalTimeouts.push(ms);
    return realTimeout(ms);
  });
  void (walk(render(), (e) => e.type === "button")[0]!.props.onClick as () => Promise<void>)();
  await settle();
  return { render, timers, signalTimeouts };
}

describe("adversary t2: the page does not wait forever for the estimate", () => {
  it("control: the page does call /tax/estimate when Estimate is pressed", async () => {
    let called = 0;
    await startEstimate(async () => {
      called++;
      return Response.json({ error: "x" });
    });
    expect(called).toBe(1);
  });

  it("puts a limit on the wait: an abort signal or a timer of seconds, so a silent server ends in the failure message", async () => {
    let seen: { signal?: AbortSignal } | null = null;
    const { timers, signalTimeouts } = await startEstimate((_u, init) => {
      seen = init;
      return new Promise<Response>(() => {}); // the server accepted the request and never answers
    });
    const bounded = seen!.signal !== undefined || timers.some((ms) => ms >= 5_000) || signalTimeouts.some((ms) => ms >= 5_000);
    expect(bounded).toBe(true);
  });
});
