// Adversary c20: after a send, the page offers the payment's hash as a link to the block explorer, and
// the link opens in the SAME tab. The page holds everything about the withdrawal in memory only (the
// anchor's token, the session, the send lock, the unknown-outcome state: spike section 5, "kept in memory:
// never ... storage"). Following the link to check the payment, which is exactly what the unknown-send
// text invites ("check whether it arrived"), unloads the page; coming back reloads it with no session, no
// lock and no memory of the payment, and the preview offers a new cash-out while the first payment may
// still land (goal 1) and with the first withdrawal no longer followed (goal 5). Every other external
// link on the page (the anchor's form) opens in a new tab with rel="noopener noreferrer".
//
// Spec: goals 1 and 5, docs/decisions.md 2026-11-27 c9 row ("Nothing offered can send USDC twice; the send
// lock stays") and c14 (an unknown send with a hash shows it and says the anchor's status decides).
// Cause: src/app/cashout/page.tsx, the `<a className="addr link" href={explorerLink("tx", sentHash)}>` has
// no target.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton, find, mount, pressContinue, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const HASH = "cb".repeat(32);
type Anchor = { props?: { href?: string; target?: string; rel?: string } };
const links = (tree: unknown) => find(tree, (e) => e.type === "a") as unknown as Anchor[];

describe("adversary c20: the payment's hash link must not unload the page that holds the withdrawal", () => {
  it("control: the anchor's form link opens in a new tab with noopener (the harness reads link targets)", async () => {
    const { rt } = await mount({});
    await pressContinue(rt);
    await tick(50);
    const form = links(rt.tree).find((a) => a.props?.href?.includes("anchor-ref-ui-testanchor"));
    expect(form?.props?.target).toBe("_blank");
    expect(form?.props?.rel).toContain("noopener");
    rt.unmount();
  });

  it("an unknown send that came with a hash: the explorer link opens in a new tab", async () => {
    const { rt, world } = await mount({
      submit: async () => ({ success: false, hash: HASH, error: { code: 5004, message: "Transaction confirmation timed out" } }),
    });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    const explorer = links(rt.tree).find((a) => a.props?.href?.includes("stellar.expert"));
    expect(explorer).toBeDefined(); // the link is offered
    expect(explorer?.props?.target).toBe("_blank");
    expect(explorer?.props?.rel).toContain("noopener");
    rt.unmount();
  });

  it("a confirmed send: the explorer link opens in a new tab", async () => {
    const { rt, world } = await mount({});
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    const explorer = links(rt.tree).find((a) => a.props?.href?.includes("stellar.expert"));
    expect(explorer).toBeDefined();
    expect(explorer?.props?.target).toBe("_blank");
    rt.unmount();
  });
});
