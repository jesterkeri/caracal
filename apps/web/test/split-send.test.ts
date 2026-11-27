// Sending a split write through the wallet's passkey and the fee relay, and
// what the person is told in each outcome. The kit is a fake that records what
// it was asked to sign; the transaction build is real in the last block.
import { Address, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeSplit, deploySplit, moveBetweenPots, withdrawToWallet } from "../src/lib/split/actions";
import { say } from "../src/lib/split/messages";
import { buildTx, sendSplitCall, type BuildTx, type WriteKit } from "../src/lib/split/send";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";
import { codeKey } from "./setup-relay-server";

afterEach(() => vi.restoreAllMocks());

const SPLIT = splitAddressFor(WALLET);
const POTS = { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) };
const HASH = "ab".repeat(32);

type Result = Awaited<ReturnType<WriteKit["signAndSubmit"]>>;
function fakeKit(result: Result | (() => never)) {
  const signAndSubmit = vi.fn(async () => (typeof result === "function" ? result() : result));
  return { kit: { rpc: {}, rpcUrl: "https://rpc.test", networkPassphrase: "Test SDF Network ; September 2015", signAndSubmit } as unknown as WriteKit, signAndSubmit };
}
const built = { built: "tx" } as never;
const build: BuildTx = vi.fn(async () => built);
const named = (name: string, message: string, extra: object = {}) => Object.assign(new Error(message), { name, ...extra });

describe("a write goes through the kit's passkey signing and the relay", () => {
  it("success: one signAndSubmit of the transaction built for that exact call, and the hash is passed on", async () => {
    const { kit, signAndSubmit } = fakeKit({ success: true, hash: HASH });
    const out = await withdrawToWallet(kit, WALLET, POTS, "Spend", BigInt(50_000), build);
    expect(out).toEqual({ kind: "done", hash: HASH });
    expect(signAndSubmit).toHaveBeenCalledTimes(1);
    expect(signAndSubmit).toHaveBeenCalledWith(built);
    const [, func, method, contractId] = vi.mocked(build).mock.calls.at(-1)!;
    expect(method).toBe("withdraw");
    expect(contractId).toBe(SPLIT);
    // Withdraws go to the owner's own wallet, never anywhere else.
    expect(Address.fromScAddress(func.invokeContract().contractAddress()).toString()).toBe(SPLIT);
    expect(Address.fromScAddress(func.invokeContract().args()[1].address()).toString()).toBe(WALLET);
  });

  it("deploy, move and set_split each send the right call", async () => {
    const { kit } = fakeKit({ success: true, hash: HASH });
    await deploySplit(kit, WALLET, 1000, 1500, build);
    expect(vi.mocked(build).mock.calls.at(-1)![1].switch().name).toBe("hostFunctionTypeCreateContractV2");
    await moveBetweenPots(kit, WALLET, POTS, "Spend", "Goal", BigInt(1), build);
    expect(vi.mocked(build).mock.calls.at(-1)![1].invokeContract().functionName().toString()).toBe("move_between");
    await changeSplit(kit, WALLET, 500, 500, build);
    expect(vi.mocked(build).mock.calls.at(-1)![1].invokeContract().functionName().toString()).toBe("set_split");
  });
});

describe("what the contract would refuse is refused before any passkey prompt", () => {
  it("withdrawing or moving more than the pot holds, zero, or between the same pot", async () => {
    const { kit, signAndSubmit } = fakeKit({ success: true, hash: HASH });
    const r1 = await withdrawToWallet(kit, WALLET, POTS, "Tax", BigInt(10_001), build);
    expect(r1.kind === "stopped" && r1.message).toMatch(/Tax pot holds 0\.001 USDC/);
    expect((await withdrawToWallet(kit, WALLET, POTS, "Tax", BigInt(0), build)).kind).toBe("stopped");
    expect((await moveBetweenPots(kit, WALLET, POTS, "Goal", "Goal", BigInt(1), build)).kind).toBe("stopped");
    expect((await moveBetweenPots(kit, WALLET, POTS, "Goal", "Spend", BigInt(15_001), build)).kind).toBe("stopped");
    expect(signAndSubmit).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
  it("a split over 100%, at deploy and at change", async () => {
    const { kit, signAndSubmit } = fakeKit({ success: true, hash: HASH });
    expect((await deploySplit(kit, WALLET, 6000, 4001, build)).kind).toBe("stopped");
    expect((await changeSplit(kit, WALLET, 10_001, 0, build)).kind).toBe("stopped");
    expect(signAndSubmit).not.toHaveBeenCalled();
  });
  it("withdrawing exactly the whole pot is allowed", async () => {
    const { kit } = fakeKit({ success: true, hash: HASH });
    expect((await withdrawToWallet(kit, WALLET, POTS, "Spend", POTS.spend, build)).kind).toBe("done");
  });
});

describe("outcomes say only what is known", () => {
  const send = (result: Result | (() => never), b: BuildTx = build) => sendSplitCall(fakeKit(result).kit, {} as never, "withdraw", SPLIT, b);

  it("the relay's own 'Nothing was sent' is the only thing that says nothing was sent", async () => {
    const out = await send({ success: false, error: named("SubmissionError", "Too many requests. Nothing was sent. Try again.") as never });
    expect(out).toEqual({ kind: "refused", message: "Too many requests. Nothing was sent. Try again." });
    // The same words with a hash are not trusted: it was sent.
    const withHash = await send({ success: false, error: named("SubmissionError", "Nothing was sent.") as never, hash: HASH });
    expect(withHash.kind).toBe("unknown");
  });
  it("a closed passkey prompt is a stop, without claiming anything about the relay", async () => {
    const err = Object.assign(named("SmartAccountError", "The operation either timed out or was not allowed."), { cause: named("NotAllowedError", "denied") });
    const out = await send({ success: false, error: err as never });
    expect(out).toEqual({ kind: "stopped", message: "The passkey prompt was closed or timed out." });
  });
  it("a failure raised before the relay is posted to is a stop with the reason", async () => {
    const out = await send({ success: false, error: named("SimulationError", "Re-simulation failed: Error(Contract, #4)") as never });
    expect(out.kind === "stopped" && out.message).toMatch(/does not hold enough/);
  });
  it("a timeout, a gateway page or an unnamed failure is unknown, never a claim either way", async () => {
    for (const msg of ["Relayer request timed out", "Relayer request failed with status 504", "Transaction confirmation timed out"]) {
      const out = await send({ success: false, error: named("SubmissionError", msg) as never });
      expect(out.kind, msg).toBe("unknown");
    }
    // After a send the kit wraps what it throws as a plain SmartAccountError: unknown.
    expect((await send({ success: false, error: named("SmartAccountError", "network error") as never })).kind).toBe("unknown");
  });
  it("a transaction that has a hash but failed on chain is unknown and keeps its hash", async () => {
    const out = await send({ success: false, error: named("SubmissionError", "Transaction failed on-chain: AAAA") as never, hash: HASH });
    expect(out).toMatchObject({ kind: "unknown", hash: HASH });
  });
  it("a throw from signAndSubmit is unknown", async () => {
    const out = await send(() => {
      throw new Error("boom");
    });
    expect(out).toEqual({ kind: "unknown", message: "boom" });
  });
  it("a call refused when first simulated is a stop, and nothing is signed", async () => {
    const { kit, signAndSubmit } = fakeKit({ success: true, hash: HASH });
    const out = await sendSplitCall(kit, {} as never, "withdraw", SPLIT, async () => {
      throw new Error("HostError: Error(Contract, #4)");
    });
    expect(out.kind === "stopped" && out.message).toMatch(/does not hold enough USDC/);
    expect(signAndSubmit).not.toHaveBeenCalled();
  });
});

describe("what the page says", () => {
  it("success names the action and links the hash", () => {
    expect(say({ kind: "done", hash: HASH }, "Your withdrawal")).toEqual({ tone: "good", text: "Your withdrawal went through.", hash: HASH });
  });
  it("refused and stopped show their own text", () => {
    expect(say({ kind: "refused", message: "Nothing was sent. Try again." }, "x")).toEqual({ tone: "bad", text: "Nothing was sent. Try again." });
    expect(say({ kind: "stopped", message: "No." }, "x").text).toBe("No.");
  });
  it("unknown says it could not confirm, and does not say nothing was sent", () => {
    const s = say({ kind: "unknown", message: "Relayer request timed out.", hash: HASH }, "Your withdrawal");
    expect(s.tone).toBe("unsure");
    expect(s.text).toMatch(/could not confirm whether your withdrawal went through/);
    expect(s.text).not.toMatch(/Nothing was sent/);
    expect(s.hash).toBe(HASH);
  });
});

describe("building the transaction for the kit (real stellar-sdk)", () => {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: Address.fromString(SPLIT).toScAddress(), functionName: "withdraw", args: [] })), subInvocations: [] }),
  });
  const simulation = (over: object) =>
    ({
      _parsed: true,
      id: "s",
      latestLedger: 1_000_000,
      events: [],
      minResourceFee: "100",
      transactionData: new SorobanDataBuilder().setReadOnly([codeKey("00".repeat(32))]).setResourceFee("100"),
      result: { auth: [entry], retval: xdr.ScVal.scvVoid() },
      ...over,
    }) as unknown as rpc.Api.SimulateTransactionResponse;

  it("simulates once and keeps the wallet's authorisation for kit.signAndSubmit to sign", async () => {
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    const sim = vi.spyOn(server, "simulateTransaction").mockResolvedValue(simulation({}));
    const kit = { rpc: server, rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015" } as unknown as WriteKit;
    const func = (await import("../src/lib/split/calls")).withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1));
    const tx = await buildTx(kit, func, "withdraw", SPLIT);
    expect(sim).toHaveBeenCalledTimes(1);
    expect(tx.simulationData.result.auth).toHaveLength(1);
    expect(tx.built?.operations[0].type).toBe("invokeHostFunction");
  });
  it("a simulation the contract refused throws its reason in plain English", async () => {
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    vi.spyOn(server, "simulateTransaction").mockResolvedValue({ _parsed: true, id: "s", latestLedger: 1, events: [], error: "HostError: Error(Contract, #4)" } as unknown as rpc.Api.SimulateTransactionResponse);
    const kit = { rpc: server, rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015" } as unknown as WriteKit;
    const func = (await import("../src/lib/split/calls")).withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1));
    await expect(buildTx(kit, func, "withdraw", SPLIT)).rejects.toThrow(/does not hold enough USDC/);
  });
});
