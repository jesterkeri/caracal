// Adversary s5: when the network answers a split write's first simulation with
// "restore expired data first" (the simulateTransaction answer carries a
// restorePreamble: an entry the call reads, such as the wallet's or the split's
// USDC balance, has expired), the page goes on, and then tells the person
// "Caracal could not confirm whether your withdrawal went through (You need to
// restore some contract state before you can invoke this method. You can set
// `restore` to true in the method options ...)".
//
// Nothing was signed and nothing was sent: kit.signAndSubmit reads
// transaction.simulationData first, which throws the SDK's ExpiredState error
// before any passkey prompt or relay call. The kit wraps it in a plain
// SmartAccountError, which send.ts does not recognise as a failure before
// sending, so it is `unknown`.
//
// Spec:
// - attacker goal 4: a person is told something false ("may have gone through"
//   when nothing was sent) and a wrong cause (developer text about a method
//   option), and goal 5: no way forward;
// - docs/decisions.md 2026-11-27 (s3 row): "A failure of that simulation is
//   called a refusal only when the network answered that the call fails ...; a
//   network that did not answer is named as such". Here the network answered,
//   and it said the data must be restored;
// - src/lib/split/send.ts: `unknown` is for "it may or may not have landed".
//
// Real parts: smart-account-kit 0.10.0 and stellar-sdk over real HTTP to a
// JSON-RPC stub and a relay stub on 127.0.0.1 (the s4 fake network's kit);
// answers are built with stellar-sdk's own XDR types.
import { Address, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { say } from "../src/lib/split/messages";
import { sendSplitCall } from "../src/lib/split/send";
import { WALLET } from "./relay-fixtures";
import { SPLIT, realKit, type Fake } from "./s4-fake-network";

/** The wallet's auth entry over split.withdraw(Spend, wallet, 1), as a simulation records it. */
function walletAuth(): xdr.SorobanAuthorizationEntry {
  const func = withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)).invokeContract();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("7"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func),
      subInvocations: [],
    }),
  });
}

/** simulateTransaction's wire answer; `expired` adds the restorePreamble the RPC sends when the call reads an archived entry. */
function simulateAnswer(expired: boolean) {
  const data = new SorobanDataBuilder().setResourceFee("100").build().toXDR("base64");
  return {
    latestLedger: 1_000_000,
    minResourceFee: "100",
    transactionData: data,
    events: [],
    results: [{ auth: [walletAuth().toXDR("base64")], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
    ...(expired ? { restorePreamble: { minResourceFee: "100", transactionData: data } } : {}),
  };
}

let net: Fake | undefined;
afterEach(async () => {
  await net?.close();
  net = undefined;
});

/** A JSON-RPC stub and a relay stub on 127.0.0.1. The relay stub refuses (429, "Nothing was sent") whatever reaches it. */
async function network(expired: boolean): Promise<Fake> {
  let relays = 0;
  const open = new Set<import("node:net").Socket>();
  const rpcServer: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = JSON.parse(raw) as { id: number; method: string };
      res.writeHead(200, { "Content-Type": "application/json" });
      if (call.method === "simulateTransaction") return void res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: simulateAnswer(expired) }));
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `fake rpc: ${call.method}` } }));
    });
  });
  const relayServer: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      relays += 1;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Too many requests. Nothing was sent. Try again." }));
    });
  });
  for (const s of [rpcServer, relayServer]) {
    s.on("connection", (sock) => {
      open.add(sock);
      sock.on("close", () => open.delete(sock));
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  }
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return {
    rpcUrl: url(rpcServer),
    relayUrl: url(relayServer),
    simulations: () => 0,
    relayCalls: () => relays,
    close: async () => {
      for (const sock of open) sock.destroy();
      await Promise.all([rpcServer, relayServer].map((s) => new Promise((r) => s.close(r))));
    },
  };
}

async function pageSays(expired: boolean) {
  vi.restoreAllMocks(); // the shared test setup fakes rpc.Server's simulateTransaction; the kit below talks real HTTP
  net = await network(expired);
  const outcome = await sendSplitCall(realKit(net), withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT);
  return { outcome, said: say(outcome, "Your withdrawal"), relayCalls: net.relayCalls() };
}

describe("adversary s5: the network says expired data must be restored before a split write", () => {
  it("control: with no expiry the same write goes through the kit to the relay, which refuses it (a refusal, as expected)", async () => {
    const r = await pageSays(false);
    expect(r.relayCalls).toBe(1);
    expect(r.outcome.kind).toBe("refused");
    expect(r.said.tone).toBe("bad");
  });

  it("an expired-data answer sends nothing, and is not shown as 'could not confirm whether ... went through'", async () => {
    const r = await pageSays(true);
    // Nothing reached the relay, so the person can be told that nothing was sent.
    expect(r.relayCalls).toBe(0);
    // Defect: kind "unknown", tone "unsure", "Caracal could not confirm whether your withdrawal went through (You need to restore some contract state ...)".
    expect(r.said.text).not.toMatch(/could not confirm whether/);
    expect(r.outcome.kind).not.toBe("unknown");
  });
});
