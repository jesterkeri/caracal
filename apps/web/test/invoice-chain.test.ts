// The invoice helpers: references, amounts, contract reads, the receipt lookup,
// and how a write's answer is told apart (done, not sent, failed, unknown).
import { Address, contract, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { formatUsdc, parseUsdc } from "../src/lib/invoices/amount";
import { cancelInvoice, createInvoice, findPaymentTx, isCaracalSplit, payInvoice, readConfig, readInvoice, readUsdcBalance } from "../src/lib/invoices/chain";
import { splitErrorText } from "../src/lib/invoices/errors";
import { newInvoiceRef, payPath, refBytes } from "../src/lib/invoices/ref";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const addr = (a: string) => new Address(a).toScVal();

afterEach(() => vi.restoreAllMocks());

/** A server whose simulation returns `retval`, or an error string. */
function server(answer: { retval?: xdr.ScVal; error?: string }) {
  return {
    simulateTransaction: vi.fn(async () => (answer.error !== undefined ? { error: answer.error } : { result: { retval: answer.retval, auth: [] } })),
  } as unknown as rpc.Server;
}

describe("reference and amount", () => {
  it("makes a 16 byte random id as 32 hex characters, and it round-trips", () => {
    const ref = newInvoiceRef();
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(refBytes(ref)?.length).toBe(16);
    expect(newInvoiceRef()).not.toBe(ref);
  });
  it("accepts only 1 to 64 bytes of lowercase hex", () => {
    expect(refBytes("")).toBeNull();
    expect(refBytes("abc")).toBeNull(); // odd length
    expect(refBytes("ABCD")).toBeNull();
    expect(refBytes("zz")).toBeNull();
    expect(refBytes("ab".repeat(64))?.length).toBe(64);
    expect(refBytes("ab".repeat(65))).toBeNull();
  });
  it("the pay link carries the split contract and the id, nothing else", () => {
    expect(payPath(SPLIT, REF)).toBe(`/pay/${SPLIT}/${REF}`);
  });
  it("parses USDC exactly in stroops and refuses everything else", () => {
    expect(parseUsdc("150")).toBe(BigInt(1_500_000_000));
    expect(parseUsdc("150.5")).toBe(BigInt(1_505_000_000));
    expect(parseUsdc("0.0000001")).toBe(BigInt(1));
    for (const bad of ["", "0", "0.0000000", "-1", "1e3", "1.12345678", "1,5", "abc", "99999999999", " "]) expect(parseUsdc(bad)).toBeNull();
  });
  it("shows every stroop, at least two decimals", () => {
    expect(formatUsdc(BigInt(1_500_000_000))).toBe("150.00");
    expect(formatUsdc(BigInt(1_505_000_000))).toBe("150.50");
    expect(formatUsdc(BigInt(1))).toBe("0.0000001");
  });
});

describe("reading the chain", () => {
  it("reads an invoice's amount and status", async () => {
    const vec = (a: bigint, s: number) => xdr.ScVal.scvVec([i128(a), nativeToScVal(s, { type: "u32" })]);
    expect(await readInvoice(server({ retval: vec(BigInt(1_500_000_000), 0) }), SPLIT, REF)).toEqual({ amount: BigInt(1_500_000_000), status: "open" });
    expect((await readInvoice(server({ retval: vec(BigInt(5), 1) }), SPLIT, REF))?.status).toBe("paid");
    expect((await readInvoice(server({ retval: vec(BigInt(5), 2) }), SPLIT, REF))?.status).toBe("cancelled");
  });
  it("an unknown invoice is null; an unknown status or an unreachable network is an error, never 'no invoice'", async () => {
    expect(await readInvoice(server({ retval: xdr.ScVal.scvVoid() }), SPLIT, REF)).toBeNull();
    await expect(readInvoice(server({ retval: xdr.ScVal.scvVec([i128(BigInt(5)), nativeToScVal(7, { type: "u32" })]) }), SPLIT, REF)).rejects.toThrow(/does not know/);
    const down = { simulateTransaction: async () => Promise.reject(new Error("network down")) } as unknown as rpc.Server;
    await expect(readInvoice(down, SPLIT, REF)).rejects.toThrow("network down");
    await expect(readInvoice(server({ retval: xdr.ScVal.scvVoid() }), SPLIT, "nothex")).rejects.toThrow(/not valid/);
  });
  it("reads the split's owner and token, and null when no contract answers", async () => {
    const cfg = xdr.ScVal.scvVec([addr(WALLET), addr(TOKENS.usdc), nativeToScVal(1000, { type: "u32" }), nativeToScVal(1500, { type: "u32" })]);
    expect(await readConfig(server({ retval: cfg }), SPLIT)).toEqual({ owner: WALLET, token: TOKENS.usdc });
    expect(await readConfig(server({ error: "HostError: Error(Storage, MissingValue)" }), SPLIT)).toBeNull();
    const down = { simulateTransaction: async () => Promise.reject(new Error("network down")) } as unknown as rpc.Server;
    await expect(readConfig(down, SPLIT)).rejects.toThrow("network down");
  });
  it("a split is Caracal's only if it holds USDC and sits at the address derived from its owner", () => {
    expect(isCaracalSplit(SPLIT, { owner: WALLET, token: TOKENS.usdc })).toBe(true);
    expect(isCaracalSplit(SPLIT, { owner: WALLET, token: TOKENS.xlm })).toBe(false);
    expect(isCaracalSplit(TOKENS.usdc, { owner: WALLET, token: TOKENS.usdc })).toBe(false); // some other contract
    expect(isCaracalSplit(SPLIT, { owner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", token: TOKENS.usdc })).toBe(false);
  });
  it("reads a USDC balance", async () => {
    expect(await readUsdcBalance(server({ retval: i128(BigInt(42)) }), WALLET)).toBe(BigInt(42));
    await expect(readUsdcBalance(server({ retval: xdr.ScVal.scvVoid() }), WALLET)).rejects.toThrow(/balance/);
  });
});

describe("finding the payment's transaction", () => {
  const event = (ref: string, tx: string, name = "split") => ({
    topic: [xdr.ScVal.scvSymbol(name), xdr.ScVal.scvSymbol("v1")],
    value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("invoice_ref"), val: xdr.ScVal.scvBytes(Buffer.from(ref, "hex")) })]),
    txHash: tx,
    inSuccessfulContractCall: true,
  });
  const reader = (events: unknown[]) =>
    ({ getLatestLedger: async () => ({ sequence: 500_000 }), getEvents: vi.fn(async () => ({ events, cursor: "c" })) }) as unknown as Pick<rpc.Server, "getEvents" | "getLatestLedger">;

  it("returns the transaction of the split event for this id, not another id's", async () => {
    const r = reader([event("aa".repeat(16), "OTHER"), event(REF, "MINE")]);
    expect(await findPaymentTx(r, SPLIT, REF)).toBe("MINE");
  });
  it("ignores other events carrying the same id (an opened invoice is not a payment)", async () => {
    expect(await findPaymentTx(reader([event(REF, "OPENED", "invoice_opened")]), SPLIT, REF)).toBeNull();
  });
  it("is null, not an error, when the node cannot say", async () => {
    const r = { getLatestLedger: async () => Promise.reject(new Error("down")), getEvents: vi.fn() } as unknown as Pick<rpc.Server, "getEvents" | "getLatestLedger">;
    expect(await findPaymentTx(r, SPLIT, REF)).toBeNull();
  });
});

describe("telling a write's answer apart", () => {
  type Fail = { success: false; error: Error & { code?: number }; hash?: string };
  const fail = (message: string, code?: number, hash?: string): Fail => Object.assign({ success: false as const }, { error: Object.assign(new Error(message), { code }), hash });
  function kitAnswering(answer: unknown, simulation?: unknown) {
    vi.spyOn(contract.AssembledTransaction, "build").mockResolvedValue({ simulation } as never);
    return { rpc: {}, signAndSubmit: vi.fn(async () => answer) } as never;
  }

  it("success is done, with the hash", async () => {
    const kit = kitAnswering({ success: true, hash: "a".repeat(64) });
    expect(await payInvoice(kit, SPLIT, WALLET, BigInt(5), REF)).toEqual({ kind: "done", hash: "a".repeat(64) });
  });
  it("the relay's 'Nothing was sent' means not sent", async () => {
    const kit = kitAnswering(fail("The relay is busy. Nothing was sent. Try again."));
    expect(await createInvoice(kit, SPLIT, REF, BigInt(5))).toMatchObject({ kind: "not-sent" });
  });
  it("a refused passkey or a call that fails when tried means not sent", async () => {
    expect(await cancelInvoice(kitAnswering(fail("The passkey prompt was closed", 4004)), SPLIT, REF)).toMatchObject({ kind: "not-sent" });
    expect(await cancelInvoice(kitAnswering(fail("resimulation failed", 5001)), SPLIT, REF)).toMatchObject({ kind: "not-sent" });
  });
  it("a failure on the network with a hash is failed, with no raw XDR shown", async () => {
    const kit = kitAnswering(fail("Transaction failed on-chain: AAAA", 5003, "b".repeat(64)));
    const out = await payInvoice(kit, SPLIT, WALLET, BigInt(5), REF);
    expect(out).toMatchObject({ kind: "failed", hash: "b".repeat(64) });
    expect(JSON.stringify(out)).not.toContain("AAAA");
  });
  it("a timeout, a lost answer or an unclear signing error is unknown: it may have landed", async () => {
    expect((await payInvoice(kitAnswering(fail("Transaction confirmation timed out", 5003, "c".repeat(64))), SPLIT, WALLET, BigInt(5), REF)).kind).toBe("unknown");
    // Fixture fix (2026-11-27, adversary i3): the real kit reports a relayer failure from its send step as 5003; 5002 comes only from before sending.
    expect((await payInvoice(kitAnswering(fail("Relayer request failed with status 504", 5003)), SPLIT, WALLET, BigInt(5), REF)).kind).toBe("unknown");
    const throwing = { rpc: {}, signAndSubmit: vi.fn(async () => Promise.reject(new Error("socket hang up"))) } as never;
    vi.spyOn(contract.AssembledTransaction, "build").mockResolvedValue({} as never);
    expect((await payInvoice(throwing, SPLIT, WALLET, BigInt(5), REF)).kind).toBe("unknown");
  });
  it("a call the network refuses when tried is not sent, in the contract's own words", async () => {
    const text = `HostError: Error(Contract, #11)\n\nEvent log (newest first):\n 0: [Diagnostic Event] contract:${SPLIT}, topics:[error, Error(Contract, #11)], data:"..."`;
    const kit = kitAnswering(undefined, { error: text });
    const signAndSubmit = (kit as unknown as { signAndSubmit: () => unknown }).signAndSubmit;
    const out = await payInvoice(kit, SPLIT, WALLET, BigInt(5), REF);
    expect(out).toEqual({ kind: "not-sent", message: expect.stringMatching(/does not match the invoice/) });
    expect(signAndSubmit).not.toHaveBeenCalled(); // nothing reached the passkey
  });
  it("the same error number from the USDC contract is not read as the split's", () => {
    const usdcLine = (n: number) => `0: [Diagnostic Event] contract:${TOKENS.usdc}, topics:[error, Error(Contract, #${n})]`;
    expect(splitErrorText(usdcLine(10), SPLIT)).toMatch(/does not hold enough USDC/);
    expect(splitErrorText(usdcLine(11), SPLIT)).toBeNull();
    expect(splitErrorText(`Error(Contract, #6) contract:${SPLIT}`, SPLIT)).toMatch(/already been paid/);
  });
});
