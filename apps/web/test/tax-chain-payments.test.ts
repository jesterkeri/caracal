// Reading a wallet's payments from the chain. The fixtures are real Soroban
// testnet RPC answers captured 2026-11-27 (see the files' capturedAt): the real
// split contract's events (an invoice_opened and a split event), its instance
// entry, its health, and a real getTransaction answer (trimmed to status,
// ledger and createdAt). Anything marked "constructed" below is not a captured
// answer: it is a real-shaped answer made to test one defect.
import { readFileSync } from "node:fs";
import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import {
  ChainReadError,
  cursorLedger,
  isoFromUnix,
  readSplitPayments,
  rpcChainReader,
  type ChainReader,
  type EventsPage,
  type RawEvent,
  type SplitExpectation,
} from "../src/lib/tax/chain-payments";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/tax/${f}`, import.meta.url), "utf8"));
const real = load("soroban-testnet-split-events.json") as {
  contract: string;
  health: { latestLedger: number; oldestLedger: number; latestLedgerCloseTime: string; oldestLedgerCloseTime: string };
  eventsPage: EventsPage;
  ledgerEntries: unknown;
};
const realTx = load("soroban-testnet-tx-and-absent.json") as {
  transaction: { hash: string; status: string; ledger: number; createdAt: string };
  missingTransaction: unknown;
  absentLedgerEntries: unknown;
};

// The real contract was deployed with a test account as its owner.
const OWNER = "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX";
const want: SplitExpectation = { contract: real.contract, owner: OWNER, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const SPLIT_EVENT_ID = "0025441513655808000-0000000001";

/** The cursor the RPC gives for a page scanned up to `ledger` (a TOID: ledger in the upper 32 bits). */
const cursorFor = (ledger: number) => `${(BigInt(ledger) * BigInt(4294967296)).toString().padStart(19, "0")}-4294967295`;

/** Constructed: an empty page that has scanned up to the newest ledger, as the real RPC ends a scan. */
const lastPage = (): EventsPage => ({ ...real.eventsPage, events: [], cursor: cursorFor(real.health.latestLedger) });

/** A reader answering from the captured data. */
function fakeChain(over: Partial<ChainReader> = {}): ChainReader {
  let calls = 0;
  return {
    health: async () => real.health,
    instance: async () => ({ kind: "wasm", hash: SPLIT.wasmHash }),
    events: async () => (calls++ === 0 ? real.eventsPage : lastPage()),
    transaction: async () => realTx.transaction,
    ...over,
  };
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

/** Constructed: a `split` v1 event in the real wire format. */
function splitEvent(o: Partial<{ id: string; contract: string; ledger: number; closedAt: string; txHash: string; owner: string; token: string; amount: bigint; tax: bigint; goal: bigint; spend: bigint; v: string; inSuccessful: boolean }> = {}): RawEvent {
  const amount = o.amount ?? BigInt(100000);
  const tax = o.tax ?? BigInt(10000);
  const goal = o.goal ?? BigInt(15000);
  const spend = o.spend ?? amount - tax - goal;
  const map = xdr.ScVal.scvMap(
    (
      [
        ["amount", i128(amount)],
        ["from", addr(OWNER)],
        ["goal", i128(goal)],
        ["invoice_ref", xdr.ScVal.scvBytes(Buffer.from("INV-1"))],
        ["owner", addr(o.owner ?? OWNER)],
        ["spend", i128(spend)],
        ["tax", i128(tax)],
        ["token", addr(o.token ?? TOKENS.usdc)],
      ] as [string, xdr.ScVal][]
    ).map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
  );
  return {
    type: "contract",
    ledger: o.ledger ?? 5923564,
    ledgerClosedAt: o.closedAt ?? "2026-11-25T21:17:43Z",
    contractId: o.contract ?? real.contract,
    id: o.id ?? "0025441513655808000-0000000002",
    txHash: o.txHash ?? realTx.transaction.hash,
    topic: [sym("split"), sym(o.v ?? "v1")],
    value: map.toXDR("base64"),
    ...(o.inSuccessful === undefined ? {} : { inSuccessfulContractCall: o.inSuccessful }),
  };
}

/** A reader whose one page holds `events` and reaches the newest ledger. */
const chainWith = (events: RawEvent[], over: Partial<ChainReader> = {}) =>
  fakeChain({ events: async () => ({ ...real.eventsPage, events, cursor: cursorFor(real.health.latestLedger) }), ...over });

describe("reading the real captured answers", () => {
  it("finds the one real payment, skips the invoice_opened event, and states the window it proved", async () => {
    const r = await readSplitPayments(fakeChain(), want);
    expect(r.kind).toBe("read");
    if (r.kind !== "read") return;
    expect(r.payments).toEqual([
      {
        eventId: SPLIT_EVENT_ID,
        txHash: realTx.transaction.hash,
        ledger: 5923564,
        occurredAt: "2026-11-25T21:17:43Z",
        units: BigInt(100000),
        invoiceRef: "INV-DAY2-2",
        from: OWNER,
      },
    ]);
    // The window is exactly what the RPC said it keeps, no more.
    expect(r.coverage).toEqual({
      fromLedger: real.health.oldestLedger,
      from: isoFromUnix(real.health.oldestLedgerCloseTime),
      toLedger: real.eventsPage.latestLedger,
      to: isoFromUnix(real.eventsPage.latestLedgerCloseTime),
    });
    expect(r.coverage.from).toBe("2026-11-20T14:15:35Z");
  });

  it("the real transaction's close time is the event's close time", () => {
    expect(isoFromUnix(realTx.transaction.createdAt)).toBe("2026-11-25T21:17:43Z");
  });

  it("the real instance entry runs Caracal's split wasm (read through the real RPC client with a stubbed network)", async () => {
    const chain = rpcChainReader("https://rpc.example", (async (_u: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body);
      expect(method).toBe("getLedgerEntries");
      return Response.json({ jsonrpc: "2.0", id: 1, result: real.ledgerEntries });
    }) as never);
    expect(await chain.instance(real.contract)).toEqual({ kind: "wasm", hash: SPLIT.wasmHash });
  });

  it("a contract the RPC has no entry for is absent (real answer)", async () => {
    const chain = rpcChainReader("https://rpc.example", (async () => Response.json({ jsonrpc: "2.0", id: 1, result: realTx.absentLedgerEntries })) as never);
    expect(await chain.instance(real.contract)).toEqual({ kind: "absent" });
    expect(await readSplitPayments(fakeChain({ instance: async () => ({ kind: "absent" }) }), want)).toEqual({ kind: "no-contract" });
  });
});

describe("refusing what cannot be relied on", () => {
  it("refuses a contract that runs other code", async () => {
    await expect(readSplitPayments(fakeChain({ instance: async () => ({ kind: "wasm", hash: "00".repeat(32) }) }), want)).rejects.toThrow(/does not run Caracal/);
    await expect(readSplitPayments(fakeChain({ instance: async () => ({ kind: "other" }) }), want)).rejects.toThrow(/does not run Caracal/);
  });

  it("refuses a payment recorded for a different owner", async () => {
    await expect(readSplitPayments(fakeChain(), { ...want, owner: "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M" })).rejects.toThrow(/different owner/);
  });

  it("refuses a payment in another token", async () => {
    await expect(readSplitPayments(chainWith([splitEvent({ token: TOKENS.xlm })]), want)).rejects.toThrow(/not in USDC/);
  });

  it("refuses amounts that do not add up, and a zero payment", async () => {
    await expect(readSplitPayments(chainWith([splitEvent({ amount: BigInt(100000), tax: BigInt(10000), goal: BigInt(15000), spend: BigInt(1) })]), want)).rejects.toThrow(/do not add up/);
    await expect(readSplitPayments(chainWith([splitEvent({ amount: BigInt(0), tax: BigInt(0), goal: BigInt(0), spend: BigInt(0) })]), want)).rejects.toThrow(/do not add up/);
    await expect(readSplitPayments(chainWith([splitEvent({ amount: BigInt(100000), tax: BigInt(-5), goal: BigInt(5), spend: BigInt(100000) })]), want)).rejects.toThrow(/do not add up/);
  });

  it("refuses a split event of a version it does not know, instead of skipping a payment", async () => {
    await expect(readSplitPayments(chainWith([splitEvent({ v: "v2" })]), want)).rejects.toThrow(/does not know/);
  });

  it("refuses a split event whose data cannot be read", async () => {
    const bad = { ...splitEvent(), value: "AAAAAQ==" };
    await expect(readSplitPayments(chainWith([bad]), want)).rejects.toThrow(ChainReadError);
    const garbage = { ...splitEvent(), value: "!!!not xdr!!!" };
    await expect(readSplitPayments(chainWith([garbage]), want)).rejects.toThrow(ChainReadError);
  });

  it("refuses an event whose topics cannot be read (it could be a payment)", async () => {
    await expect(readSplitPayments(chainWith([{ ...splitEvent(), topic: ["!!!"] }]), want)).rejects.toThrow(ChainReadError);
  });

  it("ignores events of other kinds, even with odd topics", async () => {
    const other = { ...splitEvent(), id: "x-1", topic: [sym("withdraw"), sym("v1")] };
    const r = await readSplitPayments(chainWith([other]), want);
    expect(r.kind === "read" && r.payments).toEqual([]);
  });

  it("refuses an event from another contract, an event twice, and an event outside the window", async () => {
    await expect(readSplitPayments(chainWith([splitEvent({ contract: TOKENS.usdc })]), want)).rejects.toThrow(/another contract/);
    await expect(readSplitPayments(chainWith([splitEvent(), splitEvent()]), want)).rejects.toThrow(/twice/);
    await expect(readSplitPayments(chainWith([splitEvent({ ledger: real.health.oldestLedger - 1 })]), want)).rejects.toThrow(/outside/);
    await expect(readSplitPayments(chainWith([splitEvent({ ledger: real.health.latestLedger + 1 })]), want)).rejects.toThrow(/outside/);
  });

  it("skips an event the RPC marks as not from a successful call", async () => {
    const r = await readSplitPayments(chainWith([splitEvent({ inSuccessful: false })]), want);
    expect(r.kind === "read" && r.payments).toEqual([]);
  });

  it("refuses a payment whose transaction is not a success, is in another ledger, or closed at another time", async () => {
    const tx = realTx.transaction;
    await expect(readSplitPayments(fakeChain({ transaction: async () => ({ ...tx, status: "FAILED" }) }), want)).rejects.toThrow(/could not be confirmed/);
    await expect(readSplitPayments(fakeChain({ transaction: async () => ({ ...tx, status: "NOT_FOUND" }) }), want)).rejects.toThrow(/could not be confirmed/);
    await expect(readSplitPayments(fakeChain({ transaction: async () => ({ ...tx, ledger: tx.ledger + 1 }) }), want)).rejects.toThrow(/could not be confirmed/);
    await expect(readSplitPayments(fakeChain({ transaction: async () => ({ ...tx, createdAt: String(Number(tx.createdAt) + 1) }) }), want)).rejects.toThrow(/could not be confirmed/);
  });

  it("refuses when the RPC's history window moved past where reading began", async () => {
    await expect(readSplitPayments(fakeChain({ events: async () => ({ ...real.eventsPage, oldestLedger: real.health.oldestLedger + 1 }) }), want)).rejects.toThrow(/moved/);
  });

  it("refuses unreadable windows, times and cursors", async () => {
    await expect(readSplitPayments(fakeChain({ health: async () => ({ ...real.health, oldestLedger: real.health.latestLedger + 1 }) }), want)).rejects.toThrow(/ledger range/);
    await expect(readSplitPayments(fakeChain({ health: async () => ({ ...real.health, oldestLedgerCloseTime: "yesterday" }) }), want)).rejects.toThrow(/time/);
    await expect(readSplitPayments(fakeChain({ events: async () => ({ ...real.eventsPage, cursor: "nonsense" }) }), want)).rejects.toThrow(/cursor/);
    expect(() => cursorLedger("0025568180831256575-4294967295")).not.toThrow();
    expect(cursorLedger("0025568180831256575-4294967295")).toBe(5953055);
    expect(() => cursorLedger("25568180831256575-4294967295")).toThrow(ChainReadError);
    // A cursor past the newest ledger cannot be a real scan position: it must not end the scan early.
    await expect(readSplitPayments(fakeChain({ events: async () => ({ ...real.eventsPage, cursor: cursorFor(real.health.latestLedger + 5) }) }), want)).rejects.toThrow(/cursor/);
  });

  it("keeps paging until the scan reaches the newest ledger, and refuses a scan that stops moving", async () => {
    const asked: unknown[] = [];
    const middle = { ...real.eventsPage, events: [] as RawEvent[], cursor: cursorFor(real.health.oldestLedger + 10_000) };
    const chain = fakeChain({
      events: async (_c, from) => {
        asked.push(from);
        return asked.length === 1 ? middle : asked.length === 2 ? { ...real.eventsPage, cursor: cursorFor(real.health.oldestLedger + 20_000) } : lastPage();
      },
    });
    const r = await readSplitPayments(chain, want);
    expect(asked).toEqual([{ startLedger: real.health.oldestLedger }, { cursor: middle.cursor }, { cursor: cursorFor(real.health.oldestLedger + 20_000) }]);
    expect(r.kind === "read" && r.payments.length).toBe(1);

    await expect(readSplitPayments(fakeChain({ events: async () => middle }), want)).rejects.toThrow(/stopped moving/);
    let n = 0;
    await expect(readSplitPayments(fakeChain({ events: async () => ({ ...middle, cursor: cursorFor(real.health.oldestLedger + ++n) }) }), want)).rejects.toThrow(/too many pages/);
  });

  it("refuses more payments than it can check one by one", async () => {
    const many = Array.from({ length: 101 }, (_, i) => splitEvent({ id: `0025441513655808000-${String(i + 10).padStart(10, "0")}` }));
    await expect(readSplitPayments(chainWith(many), want)).rejects.toThrow(/more than 100/);
  });
});

describe("the RPC client", () => {
  const reader = (answer: () => Promise<Response>) => rpcChainReader("https://rpc.example", answer as never);

  it("says it could not reach the RPC on a network failure, an HTTP error or a non-JSON answer", async () => {
    await expect(reader(async () => { throw new TypeError("fetch failed"); }).health()).rejects.toThrow(/could not reach/);
    await expect(reader(async () => new Response("no", { status: 502 })).health()).rejects.toThrow(/could not reach/);
    await expect(reader(async () => new Response("<html>", { status: 200 })).health()).rejects.toThrow(/could not reach/);
  });

  it("refuses a JSON-RPC error and an unhealthy node", async () => {
    await expect(reader(async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "startLedger must be within the ledger range" } })).health()).rejects.toThrow(/error/);
    await expect(reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { ...real.health, status: "unhealthy" } })).health()).rejects.toThrow(/not healthy/);
  });

  it("reads the real health answer, and refuses one without the history window", async () => {
    expect(await reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: real.health })).health()).toEqual({
      latestLedger: real.health.latestLedger,
      oldestLedger: real.health.oldestLedger,
      latestLedgerCloseTime: real.health.latestLedgerCloseTime,
      oldestLedgerCloseTime: real.health.oldestLedgerCloseTime,
    });
    await expect(reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { status: "healthy", latestLedger: 5 } })).health()).rejects.toThrow(/history/);
  });

  it("asks for events of the one contract and sends the cursor or start ledger", async () => {
    const bodies: { method: string; params: Record<string, unknown> }[] = [];
    const chain = reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: real.eventsPage }));
    const spy = rpcChainReader("https://rpc.example", (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ jsonrpc: "2.0", id: 1, result: real.eventsPage });
    }) as never);
    await spy.events(real.contract, { startLedger: 5 }, 200);
    await spy.events(real.contract, { cursor: "c" }, 200);
    expect(bodies[0]).toMatchObject({ method: "getEvents", params: { startLedger: 5, filters: [{ type: "contract", contractIds: [real.contract] }], pagination: { limit: 200 } } });
    expect(bodies[1]!.params).toMatchObject({ pagination: { cursor: "c", limit: 200 } });
    expect(bodies[1]!.params).not.toHaveProperty("startLedger");
    expect((await chain.events(real.contract, { startLedger: 5 }, 200)).events).toHaveLength(2);
  });

  it("refuses a contract record that is not the one asked for", async () => {
    const entry = (real.ledgerEntries as { entries: { key: string; xdr: string }[] }).entries[0]!;
    const wrongKey = { entries: [{ ...entry, key: "AAAA" }] };
    await expect(reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: wrongKey })).instance(real.contract)).rejects.toThrow(/contract record/);
    const twice = { entries: [entry, entry] };
    await expect(reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: twice })).instance(real.contract)).rejects.toThrow(/contract record/);
    expect(StrKey.isValidContract(real.contract)).toBe(true);
  });

  it("refuses a missing transaction (real NOT_FOUND answer) as unconfirmed", async () => {
    const chain = reader(async () => Response.json({ jsonrpc: "2.0", id: 1, result: realTx.missingTransaction }));
    const tx = await chain.transaction("0".repeat(64));
    expect(tx.status).toBe("NOT_FOUND");
  });
});
