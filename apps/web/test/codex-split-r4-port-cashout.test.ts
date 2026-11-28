// Codex split R4's three findings, ported to the cash-out send guard (send-guard.ts uses the split guard's design).
//
// 1. Rendering changed the record: sendHold wrote a legacy or unreadable record over with an inferred closeBy, and
//    anchorReceived removed a record without the wallet's Web Lock, so it could remove a newer payment's record.
//    Now rendering only reads, and every removal is under the lock.
// 2. A hold lifted before the balance was read again: Continue and Send came back as soon as a ledger past closeBy
//    was read, while the balance on screen (the one the hold text says to check) could predate the payment.
//    Now nothing starts or sends until the balance shown was read at a ledger past closeBy.
// 3. A record with no closeBy was given one inferred from the first ledger seen + 720. Now it holds until the
//    person checks their balance and clears it.
//
// Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor, kit, popup
// (adversary-c2-harness.ts). The other tab's record is written with the repo's own record shape under the real key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, buttons, clickButton, find, label, mount, text, tick, unmock } from "./adversary-c2-harness";

const KEY = `caracal.cashout.send.${WALLET}`;
const continueButton = (rt: { tree: unknown }) => buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));
/** Another tab's unknown payment: closeBy 3 ledgers (15 s) past the harness's ledger 100. */
const otherTabRecord = () => JSON.stringify({ v: 2, id: "other-tab", closeBy: 103, anchorId: "other-withdrawal-id", hash: null });

function storage(kept = new Map<string, string>()) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
  return kept;
}

describe("port of Codex split R4 #1 and #3: the guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sendHold on a record with no closeBy writes nothing and holds at any ledger", async () => {
    const old = JSON.stringify({ id: "old", beat: 1, anchorId: "a1", hash: null });
    const kept = storage(new Map([[KEY, old]]));
    const { sendHold, KIT_DEFAULT_LEDGERS } = await import("../src/lib/anchor/send-guard");
    expect(sendHold(WALLET, 2000).held).toBe(true);
    expect(sendHold(WALLET, 2000 + 10 * KIT_DEFAULT_LEDGERS)).toMatchObject({ held: true, reason: "unknown-expiry", earlier: { anchorId: "a1" } });
    expect(kept.get(KEY)).toBe(old);
  });

  it("anchorReceived does not remove the record of a payment that holds the lock", async () => {
    const kept = storage();
    const { acquireSend, anchorReceived } = await import("../src/lib/anchor/send-guard");
    const p = await acquireSend(WALLET, "a1", 1000);
    if (!p.ok) throw new Error("should begin");
    const rec = kept.get(KEY);
    await anchorReceived(WALLET, "a1"); // a report racing a payment still being sent with the same anchor id
    expect(kept.get(KEY)).toBe(rec);
    p.guard.finish("unknown");
    await p.guard.lockFree;
    await anchorReceived(WALLET, "a1");
    expect(kept.has(KEY)).toBe(false);
  });

  it("a certain outcome removes its record while the payment still holds the lock", async () => {
    const kept = storage();
    const { acquireSend } = await import("../src/lib/anchor/send-guard");
    let atRelease: boolean | undefined;
    const locks = {
      request: (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) =>
        cb({}).then((v) => {
          atRelease = kept.has(KEY);
          return v;
        }),
    };
    const p = await acquireSend(WALLET, "a1", 1000, locks as never);
    if (!p.ok) throw new Error("should begin");
    p.guard.finish("sent");
    await p.guard.lockFree;
    expect(atRelease).toBe(false);
  });

  it("clearUnknown removes only a record with no closeBy, and not while another tab holds the lock", async () => {
    const old = JSON.stringify({ id: "old", beat: 1 });
    const kept = storage(new Map([[KEY, old]]));
    const { clearUnknown } = await import("../src/lib/anchor/send-guard");
    let free = () => {};
    const busy = (navigator as unknown as { locks: { request(n: string, o: unknown, cb: () => Promise<void>): Promise<void> } }).locks.request(KEY, { ifAvailable: true }, () => new Promise<void>((r) => (free = r)));
    expect(await clearUnknown(WALLET)).toBe(false);
    expect(kept.get(KEY)).toBe(old);
    free();
    await busy;
    expect(await clearUnknown(WALLET)).toBe(true);
    expect(kept.has(KEY)).toBe(false);
    const readable = JSON.stringify({ v: 2, id: "x", closeBy: 50, anchorId: null, hash: null });
    kept.set(KEY, readable);
    await clearUnknown(WALLET);
    expect(kept.get(KEY)).toBe(readable);
  });
});

describe("port of Codex split R4 #2 and #3: the page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    unmock();
  });

  async function heldByOtherTab() {
    const store = new Map<string, string>([[KEY, otherTabRecord()]]);
    const m = await mount({ store });
    await tick(50);
    find(m.rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(10);
    expect(continueButton(m.rt)?.props?.disabled).toBe(true); // held while it may still land
    return m;
  }

  it("control: once past closeBy and the balance is read there, Continue works", async () => {
    const { rt, world } = await heldByOtherTab();
    await tick(30_000); // ledger 106: past closeBy 103
    expect(continueButton(rt)?.props?.disabled).toBe(false);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(50);
    expect(world.opened).toBe(1);
    rt.unmount();
  });

  it("stays held while the balance cannot be read after the network passes closeBy", async () => {
    const { rt, world } = await heldByOtherTab();
    world.kit.readBalance.mockResolvedValue(null); // every read from now on fails
    await tick(30_000);
    expect(continueButton(rt)?.props?.disabled).toBe(true);
    expect(text(rt)).toMatch(/reading your USDC balance again/);
    void (continueButton(rt)!.props!.onClick as () => unknown)(); // a press that outruns the render is refused too
    await tick(50);
    expect(world.opened).toBe(0);
    // A read that works frees it.
    world.kit.readBalance.mockResolvedValue(BigInt(90_000_000));
    await tick(10_000);
    expect(continueButton(rt)?.props?.disabled).toBe(false);
    rt.unmount();
  });

  it("a record with no closeBy holds with a way forward, and the person's check clears it", async () => {
    const old = JSON.stringify({ id: "old", beat: 1, anchorId: "a1", hash: null });
    const store = new Map<string, string>([[KEY, old]]);
    const { rt, world } = await mount({ store });
    await tick(50);
    find(rt.tree, (e) => e.type === "input")[0]!.props!.onChange!({ target: { value: "2" } });
    await tick(60_000); // twelve ledgers later: nothing is inferred
    expect(continueButton(rt)?.props?.disabled).toBe(true);
    expect(store.get(KEY)).toBe(old);
    void clickButton(rt.tree, /I have checked my balance/);
    await tick(10_000);
    expect(store.has(KEY)).toBe(false);
    expect(continueButton(rt)?.props?.disabled).toBe(false);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(50);
    expect(world.opened).toBe(1);
    rt.unmount();
  });
});
