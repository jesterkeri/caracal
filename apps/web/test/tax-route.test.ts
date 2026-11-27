// POST /tax/estimate and the result view. The network is a stub that answers
// with the real captured answers (fixtures/tax, captured 2026-11-27): the real
// public RPC health, and the real "no such contract" answer.
import { readFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/tax/estimate/route";
import { NOT_ADVICE, ResultView, group } from "../src/app/tax/result-view";
import type { TaxOutcome } from "../src/lib/tax/pipeline";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/tax/${f}`, import.meta.url), "utf8"));
const events = load("soroban-testnet-split-events.json");
const other = load("soroban-testnet-tx-and-absent.json");
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 9));

afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown) => POST(new Request("http://localhost/tax/estimate", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const valid = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" } };

describe("POST /tax/estimate", () => {
  it.each([
    ["invalid JSON", "{"],
    ["a wallet that is not a contract", { wallet: "nope", otherIncome: { kind: "all-in-caracal" } }],
    ["no income answer", { wallet: WALLET }],
    ["a body that is too large", JSON.stringify({ ...valid, annualRentNgn: "1".repeat(3000) })],
  ])("answers 400 for %s", async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  it("answers no-contract (never a number) when the real RPC has no contract for the wallet", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body);
      if (method === "getHealth") return Response.json({ jsonrpc: "2.0", id: 1, result: events.health });
      if (method === "getLedgerEntries") return Response.json({ jsonrpc: "2.0", id: 1, result: other.absentLedgerEntries });
      throw new Error(`unexpected ${method}`);
    });
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TaxOutcome;
    expect(body.status).toBe("no-contract");
    expect(JSON.stringify(body)).not.toMatch(/ngn/i);
  });

  it("answers unavailable (never a number) when the RPC cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const body = (await (await post(valid)).json()) as TaxOutcome;
    expect(body.status).toBe("unavailable");
  });
});

describe("the result view", () => {
  const html = (o: TaxOutcome) => renderToStaticMarkup(ResultView({ outcome: o }));
  const refused: TaxOutcome = {
    status: "refused",
    reasons: ['Account "x" has history only from 2026-11-20T14:15:35Z.', "The CBN has published no official rate for 2026-01-01"],
    disclaimer: "This is an estimate, not tax advice.",
    context: null,
  };

  it("says 'estimate, not tax advice' on every kind of answer", () => {
    const outcomes: TaxOutcome[] = [
      refused,
      { status: "unavailable", message: "Caracal could not reach the CBN rate list.", disclaimer: "x" },
      { status: "no-contract", message: "No contract.", splitContract: WALLET, disclaimer: "x" },
    ];
    for (const o of outcomes) expect(html(o)).toContain(NOT_ADVICE);
  });

  it("shows the engine's refusal reasons and no naira figure", () => {
    const out = html(refused);
    expect(out).toContain("2026-11-20T14:15:35Z");
    expect(out).toContain("no official rate for 2026-01-01");
    expect(out).toContain("refused to guess");
    expect(out).not.toMatch(/N\d/);
  });

  it("shows the message of an unavailable source", () => {
    expect(html({ status: "unavailable", message: "Caracal could not reach the CBN rate list.", disclaimer: "x" })).toContain("could not reach the CBN rate list");
  });

  it("groups naira text without touching its digits", () => {
    expect(group("1392248.10")).toBe("1,392,248.10");
    expect(group("88837.22")).toBe("88,837.22");
    expect(group("999")).toBe("999");
    expect(group("0.00")).toBe("0.00");
  });

  it("contains no em dash", () => {
    expect(html(refused)).not.toContain("—");
  });
});
