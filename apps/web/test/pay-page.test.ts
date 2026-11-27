// The pay page: what the client sees, and what each answer to a payment means.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const HASH = "d".repeat(64);
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown; href?: string } };
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
const hrefs = (node: unknown) => {
  const out: string[] = [];
  walk(node, (el) => void (el.props?.href && out.push(el.props.href)));
  return out;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.resetModules();
});

type Inv = { amount: bigint; status: "open" | "paid" | "cancelled" };
type Chain = { config?: unknown; invoice?: Inv | null; balance?: bigint; outcome?: unknown; after?: Inv | null; tx?: string | null };

/** Renders the client component with React's state stubbed. `states` are, in order: view, wallet, pay, name, createOpen. */
async function render(states: unknown[], chain: Chain = {}, props = { split: SPLIT, invoiceRef: REF }) {
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
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  let reads = 0;
  const calls = { pay: vi.fn() };
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ("config" in chain ? chain.config : { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }),
      readInvoice: async () => (reads++ === 0 || !("after" in chain) ? chain.invoice : chain.after),
      readUsdcBalance: async () => chain.balance ?? usdc(1000),
      findPaymentTx: async () => chain.tx ?? null,
      payInvoice: (...a: unknown[]) => (calls.pay(...a), Promise.resolve(chain.outcome)),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default(props), effects, setters, calls };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v as { kind: string; text?: string; hash?: string | null };
const settle = () => new Promise((r) => setTimeout(r, 10));

const open = (n: number): unknown => ({ kind: "invoice", invoice: { amount: usdc(n), status: "open" }, txHash: null });

describe("what the client sees", () => {
  it("shows the amount from the chain and offers a wallet, never an amount from the URL", async () => {
    const { tree } = await render([open(150)]);
    const t = texts(tree);
    expect(t).toMatch(/150.00\s+USDC/);
    expect(t).toContain("Use my existing wallet");
    expect(t).toContain("Create a wallet");
    expect(hrefs(tree).join()).not.toContain("?");
  });
  it("loads from the chain on open: a bad link, a foreign contract and an unknown invoice are each named", async () => {
    for (const [chain, props, expected] of [
      [{}, { split: "nonsense", invoiceRef: REF }, /pay link is not valid/],
      [{}, { split: SPLIT, invoiceRef: "ZZ" }, /pay link is not valid/],
      [{ config: null }, undefined, "kind:not-caracal"],
      [{ invoice: null }, undefined, "kind:unknown-invoice"],
      [{ invoice: { amount: usdc(5), status: "open" } }, undefined, "kind:invoice"],
    ] as [Chain, { split: string; invoiceRef: string } | undefined, RegExp | string][]) {
      const r = await render([{ kind: "loading" }], chain, props);
      await r.effects[0]!();
      await settle();
      const v = last(r.setters, 0);
      if (typeof expected === "string") expect(`kind:${v.kind}`).toBe(expected);
      else expect(v.kind).toBe("bad-link");
      vi.resetModules();
    }
  });
  it("a split whose owner does not match its address is refused (a link to someone else's contract)", async () => {
    const r = await render([{ kind: "loading" }], { config: { owner: PAYER, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" } });
    await r.effects[0]!();
    await settle();
    expect(last(r.setters, 0).kind).toBe("not-caracal");
  });
  it("a cancelled invoice says so and offers no payment", async () => {
    const { tree } = await render([{ kind: "invoice", invoice: { amount: usdc(5), status: "cancelled" }, txHash: null }, PAYER]);
    expect(texts(tree)).toContain("cancelled");
    expect(texts(tree)).not.toMatch(/Pay \d/);
  });
  it("a paid invoice links to its receipt", async () => {
    const { tree } = await render([{ kind: "invoice", invoice: { amount: usdc(5), status: "paid" }, txHash: HASH }]);
    expect(hrefs(tree)).toContain(`/receipt/${HASH}`);
  });
});

describe("paying", () => {
  const ready = (n = 150) => [open(n), PAYER];

  it("pays the amount the chain holds now, not the one on screen, then shows the receipt link", async () => {
    // The page showed 100; the chain now says 150.
    const r = await render(ready(100), { invoice: { amount: usdc(150), status: "open" }, outcome: { kind: "done", hash: HASH } });
    await click(r.tree, "Pay")();
    await settle();
    expect(r.calls.pay).toHaveBeenCalledTimes(1);
    expect(r.calls.pay.mock.calls[0].slice(1)).toEqual([SPLIT, PAYER, usdc(150), REF]);
    expect(last(r.setters, 2)).toMatchObject({ kind: "paid", hash: HASH });
  });
  it("a wallet with too little USDC is told so before anything is sent", async () => {
    const r = await render(ready(), { invoice: { amount: usdc(150), status: "open" }, balance: usdc(20) });
    await click(r.tree, "Pay")();
    await settle();
    expect(r.calls.pay).not.toHaveBeenCalled();
    const m = last(r.setters, 2);
    expect(m.text).toContain("holds 20.00 USDC");
    expect(m.text).toContain("needs 150.00 USDC");
    expect(m.text).toContain("Nothing was sent");
  });
  it("an invoice cancelled or paid since the page loaded is not paid again", async () => {
    for (const status of ["cancelled", "paid"] as const) {
      const r = await render(ready(), { invoice: { amount: usdc(150), status } });
      await click(r.tree, "Pay")();
      await settle();
      expect(r.calls.pay).not.toHaveBeenCalled();
      vi.resetModules();
    }
  });
  it("a payment refused before it was sent says it was not made", async () => {
    const r = await render(ready(), { invoice: { amount: usdc(150), status: "open" }, outcome: { kind: "not-sent", message: "The passkey prompt was closed." } });
    await click(r.tree, "Pay")();
    await settle();
    expect(last(r.setters, 2).text).toMatch(/payment was not made.*passkey prompt was closed/);
  });
  it("a lost answer is never called a failure: the chain is asked, and an invoice still open says to check before paying again", async () => {
    const r = await render(ready(), {
      invoice: { amount: usdc(150), status: "open" },
      after: { amount: usdc(150), status: "open" },
      outcome: { kind: "unknown", message: "Relayer request failed with status 504" },
    });
    await click(r.tree, "Pay")();
    await settle();
    const m = last(r.setters, 2);
    expect(m.text).toMatch(/could not confirm whether the payment went through/);
    expect(m.text).toMatch(/Do not pay again yet/);
    expect(m.text).not.toMatch(/Nothing was sent/);
  });
  it("a lost answer for a payment that did land shows as paid", async () => {
    const r = await render(ready(), {
      invoice: { amount: usdc(150), status: "open" },
      after: { amount: usdc(150), status: "paid" },
      tx: HASH,
      outcome: { kind: "unknown", message: "timed out" },
    });
    await click(r.tree, "Pay")();
    await settle();
    expect(last(r.setters, 2)).toMatchObject({ kind: "paid", hash: HASH });
  });
  it("without a connected wallet there is no Pay button", async () => {
    const { tree } = await render([open(150), null]);
    expect(() => click(tree, "Pay 150.00")).toThrow();
  });
});

describe("connecting and creating a wallet", () => {
  it("Use my existing wallet asks for the passkey afresh and keeps the wallet it returns", async () => {
    const r = await render([open(150)]);
    await click(r.tree, "Use my existing wallet")();
    await settle();
    expect(last(r.setters, 1)).toBe(PAYER);
  });
});
