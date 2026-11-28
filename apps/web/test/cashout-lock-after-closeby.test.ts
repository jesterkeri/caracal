// Ported from split adversary s13 (2026-11-28): a payment the network has passed (ledger > closeBy) kept its Web
// Lock until its kit call settled, because only acquireSend in the same tab let go of passed locks. The page's
// ledger poll lifted the hold it shows but kept the lock, so a second tab of the browser was refused ("may still go
// through") although the network had been read past closeBy, for as long as the kit call hung.
//
// Real: the page, src/lib/anchor/*, send-guard and the Web Locks stand-in (test/setup-web-locks.ts), through the c2
// hook runtime. Faked: the anchor, and a kit whose signAndSubmit never answers (an RPC gone silent). The second tab
// is a second copy of send-guard.ts (its own map of live payments), sharing this browser's storage and Web Locks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET, clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const KEY = `caracal.cashout.send.${WALLET}`;

/** Confirms a cash-out and presses Send; the kit call never answers. Returns the payment's closeBy. */
async function sendThatHangs(store: Map<string, string>) {
  const { rt, world } = await mount({ store, submit: () => new Promise(() => {}) });
  await toConfirm(rt, world);
  void clickButton(rt.tree, /Send 2 USDC/);
  await tick(500);
  expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
  const record = JSON.parse(store.get(KEY) ?? "null") as { closeBy?: number } | null;
  expect(typeof record?.closeBy).toBe("number");
  return { rt, closeBy: record!.closeBy! };
}

/** The second tab of this browser: its own copy of send-guard.ts, the same storage and Web Locks. */
async function secondTab() {
  vi.resetModules();
  return import("../src/lib/anchor/send-guard");
}

describe("the lock of a payment the network has passed, whose kit call never settles", () => {
  it("control: before closeBy, a second tab is refused", async () => {
    const store = new Map<string, string>();
    const { rt, closeBy } = await sendThatHangs(store);
    const other = await secondTab();
    const b = await other.acquireSend(WALLET, "another-withdrawal", closeBy);
    expect(b.ok).toBe(false);
    rt.unmount();
  });

  it("is let go by the page's ledger poll, so a second tab can send once the network is past closeBy", async () => {
    const store = new Map<string, string>();
    const { rt, closeBy } = await sendThatHangs(store);
    // The harness closes a ledger every 5 s; SEND_LEDGERS is 18, so closeBy passes within about 95 s. Then the
    // page's own 5 minute limit says the outcome is unknown, and its poll keeps reading the ledger.
    await tick(6 * 60_000);
    expect(text(rt)).toMatch(/no answer about the USDC payment within 5 minutes/); // the page gave up waiting: unknown
    const other = await secondTab();
    const b = await other.acquireSend(WALLET, "another-withdrawal", closeBy + 100);
    expect(b).toMatchObject({ ok: true });
    if (b.ok) b.guard.finish({ kind: "sent", hash: "ab" } as never);
    rt.unmount();
  });
});
