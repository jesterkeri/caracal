// Adversary t25 (tax estimate, whole component). A payment answer is keyed by the payment's event id, and the only
// ids a request can ever match are the ones the Stellar RPC sends: `<19 digits>-<10 digits>` (the fixture
// soroban-testnet-split-events.json, captured from the public testnet RPC 2026-11-27, shows "0025441513655808000-0000000001").
// A request whose answer names anything else can never produce a number: the pipeline always refuses it with
// "answers ... name a payment that is not one of your 2026 payments" (pipeline.ts, unknownAnswers). Like the typed
// naira that is refused before anything is read (adversary t22, t23), it should be refused before the network is
// read. Today the route reads the RPC (health, the contract record, events, every payment's transaction, holdings)
// first, and a caller can send it 6 times a minute per address at no cost.
import { readFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/tax/${f}`, import.meta.url), "utf8"));
const events = load("soroban-testnet-split-events.json");
const other = load("soroban-testnet-tx-and-absent.json");
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 9));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The real captured RPC answers (no contract for the wallet's split), counting every network read. */
function countedNetwork() {
  const reads: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    reads.push(method);
    if (method === "getHealth") return Response.json({ jsonrpc: "2.0", id: 1, result: events.health });
    if (method === "getLedgerEntries") return Response.json({ jsonrpc: "2.0", id: 1, result: other.absentLedgerEntries });
    throw new Error(`unexpected ${method}`);
  });
  return reads;
}

async function ask(classifications: Record<string, string> | undefined) {
  vi.resetModules(); // fresh per-process limits
  const { POST } = await import("../src/app/tax/estimate/route");
  const body = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" }, ...(classifications ? { classifications } : {}) };
  return POST(new Request("http://localhost/tax/estimate", { method: "POST", body: JSON.stringify(body) }));
}

describe("adversary t25: an answer that can never match a payment is refused before the network is read", () => {
  it("control: a request with an event-shaped id does read the network (the counter works)", async () => {
    const reads = countedNetwork();
    const res = await ask({ "0025441513655808000-0000000001": "income" });
    expect(res.status).toBe(200);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("control: a request with no answers reads the network", async () => {
    const reads = countedNetwork();
    await ask(undefined);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("DEFECT: an answer keyed by something that is not an RPC event id reads the network before any refusal", async () => {
    const reads = countedNetwork();
    const res = await ask({ "not-an-event-id": "income" });
    // Whatever the status, nothing may have been read for a request that cannot produce a number.
    expect(reads, `the route read the network ${reads.length} time(s) (${reads.join(", ")}) and then answered ${res.status}`).toEqual([]);
  });
});
