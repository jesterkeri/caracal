// Adversary i1: the pay page's Connect names the wrong cause for a failed lookup.
//
// Goal 4 (a wrong cause for a failure). smart-account-kit 0.10.0 says "Smart account
// contract not found on-chain ... The wallet may not have been deployed yet." for ANY
// failed lookup, a network failure included (wallet-ops.js:169). docs/decisions.md
// 2026-11-27: "The page no longer shows that text: it asks the kit's RPC ... and says
// either 'No wallet was found ...' (the network answers) or 'could not reach the
// Stellar network ... Check your connection' (it does not)". The wallet page does
// this (lookedUp in wallet/page.tsx); the pay page's connect() passes the kit's text on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const KIT_NOT_FOUND = "Smart account contract not found on-chain for credential AQIDBAUGBwgJCgsMDQ4PEA. The wallet may not have been deployed yet.";

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
  vi.restoreAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const open = { kind: "invoice", invoice: { amount: BigInt(1_500_000_000), status: "open" }, txHash: null };
const PAY = 2;

async function connectFailing(error: Error) {
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at === 0 ? open : init, (x: unknown) => setters.push({ i: at, v: x })];
      },
      useEffect: () => undefined,
    };
  });
  // The network is unreachable: the kit's lookup failed for that reason, and so does the page's own check.
  const rpc = { getLedgerEntries: async () => Promise.reject(new Error("fetch failed")) };
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ rpc, events: {}, connectWallet: async () => Promise.reject(error) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  const tree = mod.default({ split: SPLIT, invoiceRef: REF });
  await click(tree, "Use my existing wallet")();
  await new Promise((r) => setTimeout(r, 20));
  return (setters.filter((s) => s.i === PAY).at(-1)?.v as { kind: string; text: string }).text;
}

describe("Connect on the pay page, with the network unreachable", () => {
  it("control: an ordinary connect failure is shown with the page's own lead-in", async () => {
    const text = await connectFailing(new Error("The user cancelled the passkey prompt"));
    expect(text).toContain("Caracal could not connect your wallet.");
  });
  it("the kit's 'may not have been deployed yet' is not shown when the network could not be asked", async () => {
    const text = await connectFailing(new Error(KIT_NOT_FOUND));
    // Fails today: the person is told their wallet may not be deployed although nothing was found out.
    expect(text).not.toMatch(/not found on-chain|may not have been deployed/);
  });
});
