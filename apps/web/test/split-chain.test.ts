// Reading a split contract. The return values are real: captured from Stellar
// testnet on 2026-11-27 with scripts/live-split-read.mjs against
// CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSplit } from "../src/lib/split/actions";
import { readConfig, readPots } from "../src/lib/split/chain";
import { splitErrorText } from "../src/lib/split/errors";
import { SPLIT } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const LIVE_SPLIT = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const BALANCES_RETVAL = "AAAAEAAAAAEAAAADAAAACgAAAAAAAAAAAAAAAAAAJxAAAAAKAAAAAAAAAAAAAAAAAAA6mAAAAAoAAAAAAAAAAAAAAAAAAST4";
const CONFIG_RETVAL = "AAAAEAAAAAEAAAAEAAAAEgAAAAAAAAAA3dk/P6YntnpctDkmdpD9zKQqd7MebUnNsUel0Xm4SUUAAAASAAAAAVBFzV7Acpp2j9WtAlBYUt9PAo3Ogw5axSIJukhIOy8BAAAAAwAAA+gAAAADAAAF3A==";
const LIVE_OWNER = "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

afterEach(() => vi.useRealTimers());

const ok = (b64: string) => ({ result: { retval: xdr.ScVal.fromXDR(b64, "base64"), auth: [] }, latestLedger: 1 }) as unknown as rpc.Api.SimulateTransactionResponse;
const fail = (error: string) => ({ error, latestLedger: 1, events: [], id: "x", _parsed: true }) as unknown as rpc.Api.SimulateTransactionResponse;

/** A contract instance entry running the split wasm (SPLIT.wasmHash). */
function instanceEntry(hash: string = SPLIT.wasmHash): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(LIVE_SPLIT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, "hex")), storage: null })),
    }),
  );
}

/** A fake network: answers each function by name from the simulated call. */
function network(answers: Record<string, rpc.Api.SimulateTransactionResponse | (() => Promise<never>)>, entry: "live" | "none" | "archived" | "down" = "live") {
  return {
    async simulateTransaction(tx: { operations: { func: xdr.HostFunction }[] }) {
      const fn = tx.operations[0].func.invokeContract().functionName().toString();
      const a = answers[fn];
      if (!a) throw new Error(`unexpected call ${fn}`);
      return typeof a === "function" ? a() : a;
    },
    async getLedgerEntries() {
      if (entry === "down") throw new Error("connection refused");
      if (entry === "none") return { entries: [], latestLedger: 100 };
      // Fixture change (Codex split R1): the instance entry now also carries the wasm it runs, which loadSplit checks.
      return { entries: [{ liveUntilLedgerSeq: entry === "archived" ? 50 : 500, val: instanceEntry() }], latestLedger: 100 };
    },
  } as never;
}

describe("reading the pots and settings", () => {
  it("balances() from the real contract: (tax, goal, spend) in stroops", async () => {
    const pots = await readPots(network({ balances: ok(BALANCES_RETVAL) }), LIVE_SPLIT);
    expect(pots).toEqual({ tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) });
  });
  it("config() from the real contract: (owner, token, tax_bps, goal_bps)", async () => {
    const c = await readConfig(network({ config: ok(CONFIG_RETVAL) }), LIVE_SPLIT);
    expect(c).toEqual({ owner: LIVE_OWNER, token: USDC, taxBps: 1000, goalBps: 1500 });
  });
  it("a failed read is an error, never zero", async () => {
    await expect(readPots(network({ balances: fail("HostError: Error(Contract, #99)") }), LIVE_SPLIT)).rejects.toThrow(/error code 99/);
    await expect(readPots(network({ balances: { latestLedger: 1 } as never }), LIVE_SPLIT)).rejects.toThrow(/no answer/);
    // An answer that is not three amounts is not trusted.
    await expect(readPots(network({ balances: ok(CONFIG_RETVAL) }), LIVE_SPLIT)).rejects.toThrow();
  });
  it("a network that never answers ends in an error, not an endless wait", async () => {
    vi.useFakeTimers();
    const p = readPots(network({ balances: () => new Promise<never>(() => {}) }), LIVE_SPLIT);
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await caught).toMatch(/did not answer/);
  });
});

describe("finding this wallet's split contract", () => {
  const mine = splitAddressFor(WALLET);
  it("none on chain: it can be deployed, at the address the wallet always gets", async () => {
    const l = await loadSplit(network({}, "none") as never, WALLET);
    expect(l).toEqual({ kind: "absent", split: mine });
  });
  it("a contract at the address that another owner holds is refused, not shown", async () => {
    const l = await loadSplit(network({ balances: ok(BALANCES_RETVAL), config: ok(CONFIG_RETVAL) }, "live") as never, WALLET);
    // The real contract's owner is a classic account, not this wallet: it is not this wallet's.
    expect(l.kind).toBe("error");
    expect(l.kind === "error" && l.message).toMatch(/not owned by your wallet/);
  });
  it("on chain and owned by the wallet: pots and settings are read", async () => {
    // A config whose owner is WALLET, built like the contract builds it.
    const { nativeToScVal, Address } = await import("@stellar/stellar-sdk");
    const cfg = xdr.ScVal.scvVec([nativeToScVal(Address.fromString(WALLET)), nativeToScVal(Address.fromString(USDC)), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)]);
    const l = await loadSplit(network({ balances: ok(BALANCES_RETVAL), config: ok(cfg.toXDR("base64")) }) as never, WALLET);
    expect(l.kind).toBe("present");
    if (l.kind === "present") {
      expect(l.split).toBe(mine);
      expect(l.pots.spend).toBe(BigInt(75_000));
      expect(l.config.taxBps).toBe(1000);
    }
  });
  it("expired: says it must be restored, and does not offer a second deploy", async () => {
    expect((await loadSplit(network({}, "archived") as never, WALLET)).kind).toBe("archived");
  });
  it("a network that cannot be asked is an error, not 'no split yet'", async () => {
    const l = await loadSplit(network({}, "down") as never, WALLET);
    expect(l.kind).toBe("error");
    expect(l.kind === "error" && l.message).toMatch(/could not reach the Stellar network/);
    expect((await loadSplit(undefined, WALLET)).kind).toBe("error");
  });
  it("an exists-but-unreadable contract says so instead of showing zeros", async () => {
    const l = await loadSplit(network({ balances: fail("boom"), config: ok(CONFIG_RETVAL) }, "live") as never, WALLET);
    expect(l.kind).toBe("error");
    expect(l.kind === "error" && l.message).toMatch(/could not be read: boom/);
  });
});

describe("the contract's refusals in plain English", () => {
  it("maps the split contract's own codes", () => {
    expect(splitErrorText("HostError: Error(Contract, #4)")).toMatch(/does not hold enough/);
    expect(splitErrorText("Error(Contract, #1)")).toMatch(/100%/);
    expect(splitErrorText("Error(Contract, #13)")).toMatch(/split contract itself/);
    expect(splitErrorText("Error(Contract, #77)")).toMatch(/error code 77/);
  });
  it("leaves the wallet's own error codes and other text alone", () => {
    expect(splitErrorText("Error(Contract, #3003)")).toBe("Error(Contract, #3003)");
    expect(splitErrorText("Nothing was sent.")).toBe("Nothing was sent.");
  });
});
