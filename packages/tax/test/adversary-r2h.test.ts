import { describe, expect, it } from "vitest";
import { cbn } from "./helpers";
import { estimate } from "../src";

const acct = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] };
const inc = (over: Record<string, unknown> = {}) => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T05:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10000",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over });
const inp = (entries: unknown[]) =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts: [acct], profile: { incomeScope: { allIncomeInLinkedAccounts: true } } }) as never;

// README "Refusal rules": "The input is not the documented structure"; Entry: `id`, ... ; "an entry id appears twice" refuses.
describe("adv r2h tax", () => {
  it("entry with no id must refuse (status ok today, line has entryId undefined)", () => {
    const { id: _i, ...e } = inc();
    expect(estimate(inp([e])).status).toBe("refused");
  });
  it("entry with empty-string id must refuse", () => {
    expect(estimate(inp([inc({ id: "" })])).status).toBe("refused");
  });
  it("entry ids 1 (number) and \"1\" count as the same id: same payment counted twice must refuse", () => {
    expect(estimate(inp([inc({ id: 1 }), inc({ id: "1" })])).status).toBe("refused");
  });
  it("[LOW confidence] amount with surrounding/unicode whitespace must refuse (exact decimal parsing); today echoed untrimmed in the line", () => {
    expect(estimate(inp([inc({ amount: " 10000\n" })])).status).toBe("refused");
  });
});
