import { describe, expect, it } from "vitest";
import { estimate } from "../src";
import { cbn, mkt } from "./helpers";

const input = (entries: unknown[], over: Record<string, unknown> = {}) =>
  ({
    country: "NG", taxYear: 2026, asOf: "2026-12-01T12:00:00Z", entries,
    accounts: [{ id: "a1", label: "Main", lastSyncedAt: "2026-12-01T06:00:00Z", coverageFrom: "2025-01-01T00:00:00Z", gaps: [] }],
    profile: { incomeScope: { allIncomeInLinkedAccounts: true } }, ...over,
  }) as never;
const inc = (id: string, over: Record<string, unknown> = {}) => ({
  id, accountId: "a1", txHash: `tx-${id}`, occurredAt: "2026-05-10T10:00:00Z", direction: "in", kind: "income",
  asset: "USDC", amount: "500", fx: { statutory: cbn("1500", "2026-05-10"), economic: null }, ...over,
});

describe("adversary r3a: the fx gap and duplicate payments", () => {
  it("fx gap is a property of the rates (spec: (economic - statutory) / statutory)", () => {
    const r = estimate(input([inc("1", { amount: "0.0001", fx: { statutory: cbn("1500", "2026-05-10"), economic: mkt("1560", "2026-05-10") } })]));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // (1560-1500)/1500 = 4.00 %
    expect(r.incomeLines[0]!.fxGapPct).toBe("4.00");
  });
  it("same payment with whitespace / 0x tx hash is still caught", () => {
    const r = estimate(input([inc("1", { txHash: "abc123" }), inc("2", { txHash: "abc123 " })]));
    expect(r.status).toBe("refused");
  });
  it("a payment so small its naira value rounds to zero still shows the rates' gap", () => {
    const r = estimate(input([inc("1", { amount: "0.0000001", fx: { statutory: cbn("1500", "2026-05-10"), economic: mkt("1560", "2026-05-10") } })]));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.incomeLines[0]!.fxGapPct).toBe("4.00");
  });
  it("same payment with a 0x-prefixed, upper-case tx hash is still caught", () => {
    const r = estimate(input([inc("1", { txHash: "abc123" }), inc("2", { txHash: "0xABC123" })]));
    expect(r.status).toBe("refused");
  });
});
