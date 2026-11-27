// Adversary c23: the anchor changes its record AFTER Send is pressed but BEFORE the passkey signs, and the
// page still pays the record it held at the press. Between the press and the passkey prompt the page reads
// the wallet's balance (up to 10 s, BALANCE_AT_SEND_MS), builds and simulates the transfer (up to 20 s) and
// then waits for the passkey; the poll keeps running through all of it, and the "Pay to account / Memo" rows
// on the sending screen are the poll's newest record. So the person can be looking at memo B (or at "the
// anchor no longer takes a payment") while the passkey they approve pays memo A. send() compares the
// record with what the person saw only once, at the click (page.tsx send(), before `await ... readUsdcBalance`),
// and sendToAnchor(latest, ...) never looks at txnRef.current again.
//
// Spec: docs/decisions.md 2026-11-27 rows c5 ("Send ... refuses with 'Nothing was sent' on a change ...
// and pays the latest record only after the person confirms again") and c11 ("any change refuses Send once"),
// and attacker goal 1 (USDC leaves to an account, memo or amount the person did not confirm: the one on
// screen when the passkey is approved is not the one paid). A fix re-compares the newest record just before
// signing (or aborts the send), so the passkey is not asked to approve a record the anchor has replaced.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit, popup, balance read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const MEMO_A = "4845611746035792652"; // from test/fixtures/anchor/txn-pending-user-transfer-start.json
const MEMO_B = "1111111111111111111";

/** Confirm screen shown, then Send pressed while the page's balance read at the press is still pending. */
async function pressSendWithSlowBalance(change?: (txn: Record<string, unknown>) => void) {
  const seenOnScreenAtSign: string[] = [];
  let rt!: Awaited<ReturnType<typeof mount>>["rt"];
  const { rt: runtime, world } = await mount({
    submit: () => {
      seenOnScreenAtSign.push(text(rt));
      return { success: true, hash: "cb".repeat(32) };
    },
  });
  rt = runtime;
  await toConfirm(rt, world);
  expect(text(rt)).toContain(MEMO_A);
  // Every balance read from now on stays pending until released (a status change also makes the page re-read it).
  const pending: (() => void)[] = [];
  const releaseBalance = () => pending.splice(0).forEach((r) => r());
  world.kit.readBalance.mockImplementation(() => new Promise<bigint>((resolve) => pending.push(() => resolve(BigInt(90_000_000)))));
  void clickButton(rt.tree, /Send 2 USDC/);
  await tick(10);
  change?.(world.txn); // the anchor moves on while the page is still preparing the payment
  await tick(3100); // the poll reads it and the sending screen now shows it
  return { rt, world, releaseBalance, seenOnScreenAtSign };
}

describe("adversary c23: the anchor's record changes between the Send press and the passkey", () => {
  it("control: nothing changes, so the payment is signed once and the screen showed the confirmed memo", async () => {
    const { rt, world, releaseBalance, seenOnScreenAtSign } = await pressSendWithSlowBalance();
    releaseBalance();
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(seenOnScreenAtSign[0]).toContain(MEMO_A);
    rt.unmount();
  });

  it("the memo changes after the press: the screen shows the new memo, and the passkey is not asked to pay the old one", async () => {
    const { rt, world, releaseBalance, seenOnScreenAtSign } = await pressSendWithSlowBalance((t) => {
      t.withdraw_memo = MEMO_B;
    });
    // The harness did what the scenario says: the sending screen already shows the anchor's new memo.
    expect(text(rt)).toContain(MEMO_B);
    expect(text(rt)).not.toContain(MEMO_A);
    releaseBalance();
    await tick(50);
    // today: signAndSubmit is called once, for the record held at the press (memo A) while the screen shows memo B.
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    expect(seenOnScreenAtSign).toEqual([]);
    rt.unmount();
  });

  it("the anchor expires the withdrawal after the press: the passkey is not asked to pay an expired one", async () => {
    const { rt, world, releaseBalance } = await pressSendWithSlowBalance((t) => {
      t.status = "expired";
    });
    expect(text(rt)).toMatch(/expired/i);
    releaseBalance();
    await tick(50);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
