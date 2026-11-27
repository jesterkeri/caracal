// Adversary s4: when the fee relay says for certain that a split write did not
// happen, the page tells the person it "could not confirm whether" it went through.
//
// send.ts treats a failure as `refused` only when the relay's text contains
// "Nothing was sent", and every other failure without a hash as `unknown`
// (amber: "Caracal could not confirm whether your withdrawal went through").
// But /api/relay answers its definite failures for sponsored calls in other
// words:
//  - route.ts `fail(built.error, ...)` and `fail(verdict.error, ...)` (calls keep
//    "the policy's own wording", route.ts:169-171), e.g. "The network refused this
//    call in simulation ..." (sponsor.ts:77), sent before anything reaches Channels;
//  - channels.ts: "This transaction failed on the network (ONCHAIN_FAILED), so
//    nothing changed." (docs/decisions.md 2026-11-26: "`ONCHAIN_FAILED` says
//    nothing changed").
// The person is then told the outcome is unknown, and for ONCHAIN_FAILED in the
// same sentence that nothing changed.
//
// Spec:
// - attacker goal 4: "a person is told something false: ... the reverse" of
//   "success when the outcome is unknown" / "Nothing was sent when something may
//   have been sent".
// - src/lib/split/send.ts: `unknown` is "anything else: it may or may not have
//   landed". For these answers the relay has said it did not.
//
// Real parts: the relay's own POST route, its policy and sponsor code, and
// submitToChannels with the official Channels client against the local fake
// Channels of test/setup-relay-server.ts; then the real smart-account-kit
// carries the relay's real answer to the real sendSplitCall and `say`.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { say } from "../src/lib/split/messages";
import { sendSplitCall } from "../src/lib/split/send";
import { SMART_ACCOUNT, SPLIT as SPLIT_CFG } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, splitStorage } from "./relay-fixtures";
import { SPLIT, fakeNetwork, realKit, type Fake } from "./s4-fake-network";
import { fakeChannels, simulated } from "./setup-relay-server";

let net: Fake | undefined;
afterEach(async () => {
  await net?.close();
  net = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The relay's chain view: WALLET runs the wallet wasm; SPLIT_ID runs the split wasm and is owned by WALLET over USDC. */
function chain() {
  const entry = (id: string, wasm: string, storage: xdr.ScMapEntry[] | null) =>
    xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: Address.fromString(id).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")), storage })),
      }),
    );
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async (key: xdr.LedgerKey) => {
    const id = Address.fromScAddress(key.contractData().contract()).toString();
    return { entries: [{ val: id === SPLIT_ID ? entry(SPLIT_ID, SPLIT_CFG.wasmHash, splitStorage()) : entry(WALLET, SMART_ACCOUNT.accountWasmHash, null) }] };
  }) as never);
}

/** What the kit posts for the page's own withdraw: split.withdraw(Spend, wallet, 1) with the wallet's auth entry over it. */
function withdrawPayload() {
  const call = withdrawFunction(SPLIT_ID, "Spend", WALLET, BigInt(1));
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call.invokeContract()),
      subInvocations: [],
    }),
  });
  return { func: call.toXDR("base64"), auth: [entry.toXDR("base64")] };
}

/** POSTs the withdraw to the relay's real route and returns its status and JSON answer. */
async function relayAnswers() {
  chain();
  const { POST } = await import("../src/app/api/relay/route");
  const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(withdrawPayload()) }));
  return { status: r.status, body: (await r.json()) as { success: boolean; error?: string } };
}

/** The page's outcome for a withdraw when the relay answers `answer`, through the real kit. */
async function pageSays(answer: { status: number; body: object }) {
  vi.restoreAllMocks(); // the relay's spies on rpc.Server.prototype are done; the kit below talks real HTTP
  net = await fakeNetwork(2, answer.body, answer.status);
  const outcome = await sendSplitCall(realKit(net), withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT);
  expect(net.relayCalls()).toBe(1); // the kit really posted to the relay
  return { outcome, said: say(outcome, "Your withdrawal") };
}

describe("adversary s4: a relay refusal that says nothing was sent, and one that says nothing changed", () => {
  it("control: the relay's rate-limit refusal (which says 'Nothing was sent') is shown as a refusal", async () => {
    const { outcome, said } = await pageSays({ status: 429, body: { success: false, error: "Too many requests. Nothing was sent. Try again." } });
    expect(outcome.kind).toBe("refused");
    expect(said.tone).toBe("bad");
  });

  it("the relay's real answer to a call the network refuses in simulation is not shown as 'could not confirm'", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => ({ _parsed: true, id: "sim", latestLedger: 1_000_000, events: [], error: "HostError: Error(Auth, InvalidAction)" }) as never);
    const answer = await relayAnswers();
    expect(answer.status).toBe(400);
    // Precondition updated (2026-11-27): the Day 1 relay fix (f3ff5a8) adds "Nothing was sent." to every pre-send call refusal.
    expect(answer.body.error).toBe("The network refused this call in simulation (a signature or contract check failed). Nothing was sent.");
    expect(fakeChannels.requests).toHaveLength(0); // the relay did not send it to Channels: it is certain nothing was sent

    const { said } = await pageSays(answer);
    // Defect: tone "unsure", "Caracal could not confirm whether your withdrawal went through (The network refused ...)".
    expect(said.text).not.toMatch(/could not confirm whether/);
    expect(said.tone).toBe("bad");
  });

  it("the relay's real answer to a transaction that failed on chain (ONCHAIN_FAILED, 'nothing changed') is not shown as 'could not confirm'", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => simulated([SPLIT_CFG.wasmHash, SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]));
    fakeChannels.reply = (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "x", data: { code: "ONCHAIN_FAILED" } }));
    };
    const answer = await relayAnswers();
    expect(answer.body.error).toBe("This transaction failed on the network (ONCHAIN_FAILED), so nothing changed.");
    expect(fakeChannels.requests).toHaveLength(1); // it did reach Channels and the ledger, and failed

    const { said } = await pageSays(answer);
    // Defect: one sentence says both "could not confirm whether your withdrawal went through" and "so nothing changed".
    expect(said.text).not.toMatch(/could not confirm whether/);
    expect(said.tone).toBe("bad");
  });
});
