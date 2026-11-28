// Adversary c34: a refusal "no cash-out can start or send until it has read your balance again" stays on screen,
// in the red error box, after the balance has been read and Continue works again.
//
// How: another tab's unknown payment holds the wallet (closeBy 103). The network passes closeBy, but the balance read
// fails, so the page is `stale` (nothing starts or sends until the balance is read past closeBy). The person presses
// Continue; start() refuses with `setProblem(STALE)`. The balance read then succeeds, `stale` ends, Continue is enabled
// and works, but the red box still says "no cash-out can start or send until it has read it".
//
// Spec: docs/decisions.md 2026-11-28 c31 row (a refusal's text is not kept on screen once the network has passed the
// payment / the hold has lifted), and the c32 row (an unknown send's "may still go through" ends when it no longer
// may). c31 fixed this for the "earlier payment" hold text (heldText); the newer STALE refusal (page.tsx start() and
// send(), `setProblem(STALE)`) is not registered with heldText, so nothing ever clears it (page.tsx shownProblem).
// Attacker goal 4: the person is told something false (a hold reason that no longer holds).
//
// No money moves; the harm is a false, red "nothing can start" next to a button that works. The test passes for any fix
// that drops the text once the gate has lifted (or never shows it as a remembered problem).
// Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, find, label, mount, text, tick, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const KEY = `caracal.cashout.send.${WALLET}`;
const continueButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));
const WORDS = /no cash-out can start or send until it has read it/;

async function stale() {
  const store = new Map<string, string>([[KEY, JSON.stringify({ v: 2, id: "other-tab", closeBy: 103, anchorId: "other-withdrawal-id", hash: null })]]);
  const m = await mount({ store });
  await tick(50);
  find(m.rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
  await tick(10);
  m.world.kit.readBalance.mockResolvedValue(null); // every balance read from now on fails
  await tick(30_000); // the network passes closeBy 103, but no balance was read past it
  return m;
}

describe("adversary c34: the STALE refusal outlives the gate", () => {
  it("control: while the balance cannot be read, the page says nothing can start, and the press is refused", async () => {
    const { rt, world } = await stale();
    expect(continueButton(rt)?.props?.disabled).toBe(true);
    void (continueButton(rt)!.props!.onClick as () => unknown)();
    await tick(50);
    expect(world.opened).toBe(0);
    expect(text(rt)).toMatch(WORDS);
    rt.unmount();
  });

  it("once the balance is read and Continue is enabled, the red 'nothing can start' sentence is gone", async () => {
    const { rt, world } = await stale();
    void (continueButton(rt)!.props!.onClick as () => unknown)(); // a press that outruns the render: refused, text remembered
    await tick(50);
    world.kit.readBalance.mockResolvedValue(BigInt(90_000_000)); // a read works now
    await tick(10_000);
    expect(continueButton(rt)?.props?.disabled).toBe(false); // the gate has lifted
    expect(text(rt)).not.toMatch(WORDS);
    rt.unmount();
  });
});
