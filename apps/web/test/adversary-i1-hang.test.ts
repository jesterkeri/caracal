// Adversary i1: the pay page waits for the Stellar RPC with no limit.
//
// Goal 5 (a person left stuck: a page that hangs without bound). The wallet page
// bounds every wait on the network (restoreWithin, 30 s; LOOKUP_TIMEOUT_MS, 10 s;
// docs/decisions.md 2026-11-26 "Loading the wallet kit and restoring a saved
// wallet each have a 30 s limit"). The pay page reads the invoice with the real
// stellar-sdk rpc.Server, which has no timeout of its own (relay/sponsor.ts says
// so: "The SDK has no timeout by default"). A browser's fetch to a node that
// accepts the request and never answers does not end either, so the client stays
// on "Reading the invoice from Stellar." for good: no error, no way on.
//
// The silent node is modelled by simulateTransaction returning a promise that
// never settles (what a request with no answer looks like to the caller).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("react");
  vi.resetModules();
});

/** Renders the pay client with React state stubbed; the effect is returned, not run. */
async function render(simulate: () => Promise<never>) {
  const effects: (() => unknown)[] = [];
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  // test/setup-relay-server.ts fakes simulateTransaction for the relay tests; here the node's answer is the test's.
  const { rpc } = await import("@stellar/stellar-sdk");
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(simulate);
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  mod.default({ split: SPLIT, invoiceRef: REF });
  return { effects, setters };
}

const viewNow = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string } | undefined;

describe("the pay page does not wait for the network without end", () => {
  it("control: when the node answers with a failure the load ends in an error view", async () => {
    const { effects, setters } = await render(() => Promise.reject(new Error("fetch failed")));
    effects[0]!();
    await vi.waitFor(() => expect(viewNow(setters)).toBeDefined());
    expect(viewNow(setters)?.kind).toBe("error");
  });

  it("a node that never answers ends in an error within ten minutes, not in 'Reading the invoice' forever", async () => {
    vi.useFakeTimers();
    const { effects, setters } = await render(() => new Promise<never>(() => {}));
    effects[0]!();
    // Ten minutes pass on the page's own timers.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Fails today: no view was ever set, the page is still on its initial "loading" view.
    expect(viewNow(setters)?.kind).toBe("error");
  });
});
