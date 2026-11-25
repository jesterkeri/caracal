import { describe, expect, it } from "vitest";
import { cbn } from "./helpers";
import { estimate } from "../src";

const acct = { id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] as { from: string; to: string }[] };
const inc = (over: Record<string, unknown> = {}) => ({
  id: "1", accountId: "a1", txHash: "t", occurredAt: "2026-05-10T05:00:00Z", direction: "in", kind: "income", asset: "USDC", amount: "10000",
  fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over });
const inp = (entries: unknown[], accounts: unknown[] = [acct], extra: Record<string, unknown> = {}) =>
  ({ country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries, accounts, profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...extra }) as never;
// JSON.parse can build an object whose String() throws (toString is not callable).
const weird = () => JSON.parse('{"toString":1}');

// README: "Malformed JSON is refused with a reason, never thrown."
describe("adv r2j tax: untyped JSON must refuse, never throw (HIGH confidence)", () => {
  it("entry kind that is an object", () => {
    expect(() => estimate(inp([inc({ kind: weird() })]))).not.toThrow();
  });
  it("entry direction that is an object", () => {
    expect(() => estimate(inp([inc({ direction: weird() })]))).not.toThrow();
  });
  it("account label that is an object on a stale account", () => {
    expect(() => estimate(inp([], [{ ...acct, label: weird(), lastSyncedAt: "2026-01-01T00:00:00Z" }]))).not.toThrow();
  });
  it("asOf that is an object", () => {
    expect(() => estimate(inp([], [acct], { asOf: weird() }))).not.toThrow();
  });
  it("statutory quote.quote that is an object", () => {
    const e = inc({ fx: { statutory: cbn("1500", "2026-05-10", { quote: weird() }), economic: null } });
    expect(() => estimate(inp([e]))).not.toThrow();
  });
  it("asset that is an object", () => {
    expect(() => estimate(inp([inc({ asset: weird() })]))).not.toThrow();
  });
});

describe("adv r2j tax: duplicate payment [MEDIUM confidence]", () => {
  // README: "Two income entries share the same account, txHash, asset and amount: they look like the same payment listed twice."
  it("same payment listed with amount 10000 and 10000.0 is not double counted", () => {
    const r = estimate(inp([inc({ id: "1" }), inc({ id: "2", amount: "10000.0" })]));
    expect(r.status === "refused" || (r.status === "ok" && r.grossIncomeNgn === "15000000.00")).toBe(true);
  });
  it("same payment with txHash differing only in hex case is not double counted [LOW]", () => {
    const r = estimate(inp([inc({ id: "1", txHash: "abcdef" }), inc({ id: "2", txHash: "ABCDEF" })]));
    expect(r.status === "refused" || (r.status === "ok" && r.grossIncomeNgn === "15000000.00")).toBe(true);
  });
});

describe("adv r2j tax: wrongly refuse [LOW confidence]", () => {
  // README: "A gap is [from, to)" - an empty gap has no missing history.
  it("a zero-length gap inside the year is not missing history", () => {
    const r = estimate(inp([], [{ ...acct, gaps: [{ from: "2026-06-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }] }]));
    expect(r.status).toBe("ok");
  });
});
