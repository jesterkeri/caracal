// Adversary i14: boundary and hostile-input probes over the invoices helpers and the relay policy for invoice
// calls. All of these pass on 51811c3; they are kept as regression tests for the promises they pin
// (docs/decisions.md: exact amounts, one lowercase-hex reference of 1 to 64 bytes, "cannot open any more" only
// past opens_by_ledger, a deposit only from a Caracal passkey wallet, a lost answer is never "not sent").
import { Address, contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUsdc } from "../src/lib/invoices/amount";
import { refBytes } from "../src/lib/invoices/ref";
import { checkDetails } from "../src/lib/invoices/details";
import { cannotOpenAnyMore } from "../src/lib/invoices/rows";
import { cancelInvoice, createInvoice, payInvoice } from "../src/lib/invoices/chain";
import { checkPayload } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { SMART_ACCOUNT, SPLIT } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { OLD_SPLIT_HASH, OLD_SPLIT_ID, SPLIT_ID, WALLET, addr, lookupInstance } from "./relay-fixtures";

describe("amounts and references: hostile text", () => {
  it("refuses digits that are not ASCII, exponents, hex, signs, separators and trailing newlines", () => {
    for (const bad of ["١٢٣", "１２", "1e7", "0x10", "+1", "-1", "1_0", "1.", ".5", "1..5", "1\n2", "1.5\u0000", "00000000001", "1000000000.0000001", "1000000001"]) {
      expect(parseUsdc(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("control: the largest accepted amount and the smallest", () => {
    expect(parseUsdc("1000000000")).toBe(BigInt(10_000_000_000_000_000));
    expect(parseUsdc("1000000000.0000000")).toBe(BigInt(10_000_000_000_000_000));
    expect(parseUsdc("0.0000001")).toBe(BigInt(1));
    expect(parseUsdc(" 12.5 ")).toBe(BigInt(125_000_000));
  });
  it("a reference is lowercase hex of whole bytes only, 1 to 64 bytes", () => {
    for (const bad of ["ab\n", "ab ", "0x", "ａｂ", "AB", "a", "ab".repeat(65), "ab\u0000"]) expect(refBytes(bad), JSON.stringify(bad)).toBeNull();
    expect(refBytes("ab")?.length).toBe(1);
    expect(refBytes("ab".repeat(64))?.length).toBe(64);
  });
});

describe("details limits", () => {
  it("120 and 500 are accepted, one past is refused, whitespace-only names are refused", () => {
    expect(checkDetails("a".repeat(120), "d".repeat(500)).ok).toBe(true);
    expect(checkDetails("a".repeat(121), "").ok).toBe(false);
    expect(checkDetails("a", "d".repeat(501)).ok).toBe(false);
    expect(checkDetails(" \t\n ", "").ok).toBe(false);
  });
});

describe("cannotOpenAnyMore: only a read strictly past the last ledger proves an opening cannot land", () => {
  const at = (readAt: unknown, by: unknown) => cannotOpenAnyMore({ chain: null, readAt: readAt as number, opens_by_ledger: by as number });
  it("the last ledger itself is not past it; one later is", () => {
    expect(at(2060, 2060)).toBe(false);
    expect(at(2061, 2060)).toBe(true);
  });
  it("a missing, string, unsafe or non-number ledger never proves it", () => {
    for (const [r, b] of [[undefined, 1], ["2061", 2060], [2061, "2060"], [2061, Number.NaN], [Number.NaN, 1]]) expect(at(r, b)).toBe(false);
  });
  it("an invoice on chain, or an unreadable answer, never proves it", () => {
    expect(cannotOpenAnyMore({ chain: { amount: BigInt(1), status: "open" }, readAt: 9999, opens_by_ledger: 1 })).toBe(false);
    expect(cannotOpenAnyMore({ chain: "unreadable", readAt: 9999, opens_by_ledger: 1 })).toBe(false);
  });
});

describe("a write whose answer is unclear is never 'not sent'", () => {
  const fail = (message: string, code?: number, hash?: string) => ({ success: false as const, error: Object.assign(new Error(message), { code }), hash });
  const kitAnswering = (answer: unknown) => {
    vi.spyOn(contract.AssembledTransaction, "build").mockResolvedValue({ simulation: undefined } as never);
    return { rpc: {}, signAndSubmit: vi.fn(async () => answer) } as never;
  };
  const ref = "0123456789abcdef0123456789abcdef";
  const split = splitAddressFor(WALLET);
  afterEach(() => vi.restoreAllMocks());

  it("control: a closed passkey prompt is not sent", async () => {
    expect((await createInvoice(kitAnswering(fail("closed", 4004)), split, ref, BigInt(5), 1060)).kind).toBe("not-sent");
  });
  it("every other kit code, a missing code, a hash-less timeout and a bare relay failure stay unknown", async () => {
    for (const code of [undefined, 5003, 5004, 7003, 8001, 9001, 1001, 3003]) {
      expect((await cancelInvoice(kitAnswering(fail("Relayer request failed with status 502", code)), split, ref)).kind, String(code)).toBe("unknown");
    }
  });
  it("a 429 from the fee relayer, which does not show whether anything was sent, is unknown", async () => {
    const text = "The fee relayer turned this request away as busy (HTTP 429), but that does not show whether the transaction was sent. Check your activity before trying again.";
    expect((await payInvoice(kitAnswering(fail(text, 5003)), split, WALLET, BigInt(5), ref)).kind).toBe("unknown");
  });
  it("a failed outcome needs the relay's exact ONCHAIN_FAILED report or a hash with the kit's on-chain text", async () => {
    expect((await payInvoice(kitAnswering(fail("Transaction failed on-chain: AAAA", 5003)), split, WALLET, BigInt(5), ref)).kind).toBe("unknown");
    expect((await payInvoice(kitAnswering(fail("The fee relayer could not confirm this transaction (ONCHAIN_FAILED). Check your activity.", 5003)), split, WALLET, BigInt(5), ref)).kind).toBe("unknown");
    expect((await payInvoice(kitAnswering(fail("This transaction failed on the network (ONCHAIN_FAILED), so nothing changed.", 5003)), split, WALLET, BigInt(5), ref)).kind).toBe("failed");
  });
  it("the signature expiry given for an opening reaches the kit, and a cancel or payment gives none", async () => {
    const open = kitAnswering({ success: true, hash: "a".repeat(64) });
    await createInvoice(open, split, ref, BigInt(5), 1234);
    expect((open as unknown as { signAndSubmit: { mock: { calls: unknown[][] } } }).signAndSubmit.mock.calls[0]![1]).toEqual({ expiration: 1234 });
    const pay = kitAnswering({ success: true, hash: "a".repeat(64) });
    await payInvoice(pay, split, WALLET, BigInt(5), ref);
    expect((pay as unknown as { signAndSubmit: { mock: { calls: unknown[][] } } }).signAndSubmit.mock.calls[0]).toHaveLength(1);
  });
});

describe("relay policy for invoice calls", () => {
  const callArgs = (contract: string, fn: string, args: xdr.ScVal[]) =>
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contract).toScAddress(), functionName: fn, args });
  const host = (c: xdr.InvokeContractArgs) => xdr.HostFunction.hostFunctionTypeInvokeContract(c).toXDR("base64");
  const auth = (c: xdr.InvokeContractArgs) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("7"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(c), subInvocations: [] }),
    }).toXDR("base64");
  const ref = xdr.ScVal.scvBytes(Buffer.from("0123456789abcdef0123456789abcdef", "hex"));
  const amount = nativeToScVal(BigInt(100), { type: "i128" });
  const wasm: Record<string, string> = { [WALLET]: SMART_ACCOUNT.accountWasmHash, [SPLIT_ID]: SPLIT.wasmHash, [OLD_SPLIT_ID]: OLD_SPLIT_HASH };
  const lookup = async (id: string) => wasm[id] ?? null;
  const verdict = (c: xdr.InvokeContractArgs) => checkPayload({ func: host(c), auth: [auth(c)] }, CARACAL_POLICY, lookup, lookupInstance);

  it("control: a deposit from a Caracal wallet, create_invoice and cancel_invoice on a Caracal split are sponsored", async () => {
    expect((await verdict(callArgs(SPLIT_ID, "deposit", [addr(WALLET), amount, ref]))).ok).toBe(true);
    expect((await verdict(callArgs(SPLIT_ID, "create_invoice", [ref, amount]))).ok).toBe(true);
    expect((await verdict(callArgs(SPLIT_ID, "cancel_invoice", [ref]))).ok).toBe(true);
  });
  it("a deposit whose payer is the split itself, or not an address, is refused", async () => {
    expect((await verdict(callArgs(SPLIT_ID, "deposit", [addr(SPLIT_ID), amount, ref]))).ok).toBe(false);
    expect((await verdict(callArgs(SPLIT_ID, "deposit", [ref, amount, ref]))).ok).toBe(false);
  });
  it("an invoice call on the superseded split contract is refused", async () => {
    expect((await verdict(callArgs(OLD_SPLIT_ID, "create_invoice", [ref, amount]))).ok).toBe(false);
  });
  it("a deposit through a wallet's execute still has its payer checked, and a nested execute is refused", async () => {
    const inner = (from: string) => xdr.ScVal.scvVec([addr(from), amount, ref]);
    const exec = (from: string) => callArgs(WALLET, "execute", [addr(SPLIT_ID), xdr.ScVal.scvSymbol("deposit"), inner(from)]);
    expect((await verdict(exec(WALLET))).ok).toBe(true);
    expect((await verdict(exec(SPLIT_ID))).ok).toBe(false);
    const nested = callArgs(WALLET, "execute", [addr(WALLET), xdr.ScVal.scvSymbol("execute"), xdr.ScVal.scvVec([addr(SPLIT_ID), xdr.ScVal.scvSymbol("create_invoice"), xdr.ScVal.scvVec([ref, amount])])]);
    expect((await verdict(nested)).ok).toBe(false);
  });
});
