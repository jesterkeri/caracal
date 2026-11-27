// Adversary i13: Connect on the pay page waits for the Stellar RPC with no limit.
//
// Goal 5 (a person left stuck: a page that hangs without bound). docs/decisions.md 2026-11-27 (row on the
// pay page's reads) limits every network wait on the pay and invoices pages (simulations, event pages,
// building a call, the 5 minute send), and adversary i1 proved the load did not hang for ever. Connect is
// the one wait left without a limit: after the passkey answers, the real smart-account-kit 0.10.0
// (dist/kit/wallet-ops.js connectWithCredentials) asks its own rpc.Server for the wallet's contract
// (getContractData), and that server is built with `new RpcServer(config.rpcUrl)` (dist/kit.js:271), which
// has no timeout (relay/sponsor.ts says so too). A node that accepts the request and never answers leaves
// pay-client.tsx connect() on "Waiting for your passkey" with Connect disabled (busy) for good: no error,
// no way on except reloading, and the invoice cannot be paid.
//
// This test uses the real SmartAccountKit class (MemoryStorage, as getKit({ saveSession: false }) builds it).
// Only the passkey sheet (kit.webAuthn.startAuthentication, which needs a browser) and the RPC's answers are
// replaced, like the other i-series tests: a silent node is a promise that never settles.
import { SmartAccountKit, MemoryStorage } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK, SMART_ACCOUNT } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function walk(node: unknown, f: (el: El) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, f));
  if (typeof node !== "object" || node === null) return;
  f(node as El);
  walk((node as El).props?.children, f);
}
function click(node: unknown, text: string): () => unknown {
  let found: (() => unknown) | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el.props.onClick;
  });
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

/** A real kit, as getKit({ saveSession: false }) builds it, whose passkey sheet answers at once and whose node answers as `contractData` says. */
function payerKit(contractData: () => Promise<unknown>) {
  const kit = new SmartAccountKit({
    rpcUrl: NETWORK.rpcUrl,
    networkPassphrase: NETWORK.passphrase,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://127.0.0.1:9/api/relay",
    storage: new MemoryStorage(),
    rpId: "caracal.test",
    rpName: "Caracal",
    indexerUrl: false,
    horizonUrl: false,
  });
  const k = kit as unknown as { webAuthn: { startAuthentication: unknown }; rpc: Record<string, unknown> };
  k.webAuthn.startAuthentication = async () => ({ id: "AQIDBA", rawId: "AQIDBA", type: "public-key", response: {}, clientExtensionResults: {} });
  k.rpc.getContractData = vi.fn(contractData);
  // The page asks the same node whether a wallet exists once Connect has failed; here it answers "no entry".
  k.rpc.getLedgerEntries = vi.fn(async () => ({ entries: [], latestLedger: 100 }));
  return kit;
}

/** Renders the pay client with React state stubbed: view, wallet, pay. The invoice is open and no wallet is connected yet. */
async function render(kit: SmartAccountKit) {
  const setters: { i: number; v: unknown }[] = [];
  const states: unknown[] = [{ kind: "invoice", invoice: { amount: usdc(150), status: "open" }, txHash: null }, null, { kind: "idle" }];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: () => undefined,
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => kit }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), setters };
}

const payNow = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 2).at(-1)?.v as { kind: string; text?: string } | undefined;

describe("Connect on the pay page does not wait for the network without end", () => {
  it("control: when the node answers that the wallet's contract is not there, Connect ends with a message", async () => {
    const { tree, setters } = await render(payerKit(() => Promise.reject(new Error("no such contract"))));
    await click(tree, "Use my existing wallet")();
    await vi.waitFor(() => expect(payNow(setters)?.kind).toBe("message"));
    expect(payNow(setters)?.text).toMatch(/No Caracal wallet was found/);
  });

  it("a node that never answers ends in a message within ten minutes, not in 'Waiting for your passkey' for ever", async () => {
    vi.useFakeTimers();
    const kit = payerKit(() => new Promise<never>(() => {}));
    const { tree, setters } = await render(kit);
    void click(tree, "Use my existing wallet")();
    // Ten minutes pass on the page's own timers (the passkey sheet answered at the first tick).
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // The real kit really did reach the silent node: the wait is on its getContractData.
    expect((kit.rpc as unknown as { getContractData: ReturnType<typeof vi.fn> }).getContractData).toHaveBeenCalled();
    // Fails today: the page is still busy, with no message and no way forward.
    expect(payNow(setters)?.kind).toBe("message");
  });
});
