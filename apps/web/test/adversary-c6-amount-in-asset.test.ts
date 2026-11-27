// Adversary c6: the page sends USDC for an anchor record that asks for a different asset.
//
// Spec: src/lib/anchor/transfer.ts paymentFor(): "Throws, before anything is signed, if the anchor's
// request is not exactly a USDC payment of the confirmed amount to a classic account with an id
// memo." and docs/research/anchor-spike-2026-11-27.md section 5 ("the page requires the anchor's
// amount_in to equal the amount the user chose"). Goal 1: USDC leaves the wallet for something the
// person did not confirm (a cash-out of Circle USDC; the record says the anchor wants another asset).
// Cause: parseTransaction() (src/lib/anchor/sep24.ts) never reads `amount_in_asset`, and paymentFor()
// checks the status, the account, the memo and the amount, but not the asset the anchor names, so
// the wallet signs a Circle USDC transfer for a withdrawal the anchor denominated in another asset.
//
// Real: the repo's captured anchor record (test/fixtures/anchor/txn-pending-user-transfer-start.json)
// with ONE field edited (amount_in_asset: same code, a different issuer), and the page's own
// sendToAnchor(). Faked: only the dependencies (the build and the kit's signAndSubmit are spies).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")) as { transaction: Record<string, unknown> };
const TWO = BigInt(20_000_000);
// A valid account that is not Circle's USDC issuer (GBBD47IF...): the anchor's own deposit account from the same fixture.
const OTHER_ISSUER = "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF";

const deps = () => {
  const buildTransfer = vi.fn(async () => ({ assembled: true }));
  const signAndSubmit = vi.fn(async () => ({ success: true as const, hash: "cb".repeat(32) }));
  return { buildTransfer, signAndSubmit, deps: { buildTransfer, signAndSubmit } as SendDeps };
};

describe("adversary c6: the asset the anchor names for the USDC it wants", () => {
  it("control: the captured record (amount_in_asset is Circle USDC) is paid, once", async () => {
    expect(fixture.transaction.amount_in_asset).toBe("stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    const d = deps();
    const r = await sendToAnchor(parseTransaction(fixture), TWO, d.deps);
    expect(r.kind).toBe("sent");
    expect(d.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it("a record whose amount_in_asset is another issuer's USDC is refused before anything is signed", async () => {
    const edited = { transaction: { ...fixture.transaction, amount_in_asset: `stellar:USDC:${OTHER_ISSUER}` } };
    const d = deps();
    const r = await sendToAnchor(parseTransaction(edited), TWO, d.deps);
    expect(d.signAndSubmit).not.toHaveBeenCalled(); // no passkey prompt, nothing sent
    expect(r.kind).toBe("not-sent");
  });

  it("a record whose amount_in_asset is not a Stellar asset at all is refused before anything is signed", async () => {
    const edited = { transaction: { ...fixture.transaction, amount_in_asset: "iso4217:NGN" } };
    const d = deps();
    const r = await sendToAnchor(parseTransaction(edited), TWO, d.deps);
    expect(d.signAndSubmit).not.toHaveBeenCalled();
    expect(r.kind).toBe("not-sent");
  });
});
