// Shared by the adversary s4 tests: the real smart-account-kit and stellar-sdk
// talking over real HTTP to a JSON-RPC endpoint and a relay stub on 127.0.0.1.
// Faked: the passkey prompt and the kit's context-rule lookup (both run before
// anything the s4 tests examine), and the answers, which are built with
// stellar-sdk's own XDR types.
import { Address, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { SmartAccountKit } from "smart-account-kit";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withdrawFunction } from "../src/lib/split/calls";
import type { WriteKit } from "../src/lib/split/send";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

export const PASSPHRASE = "Test SDF Network ; September 2015";
export const SPLIT = splitAddressFor(WALLET);

/** The one auth entry a withdraw needs: the wallet authorising split.withdraw(Spend, wallet, 1). */
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

/** A successful simulateTransaction answer in the JSON-RPC wire shape stellar-sdk parses. */
function simulateAnswer() {
  return {
    latestLedger: 1_000_000,
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder().setResourceFee("100").build().toXDR("base64"),
    events: [],
    results: [{ auth: [walletAuth().toXDR("base64")], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
  };
}

export type Fake = { rpcUrl: string; relayUrl: string; simulations: () => number; relayCalls: () => number; close: () => Promise<void> };

/**
 * A JSON-RPC endpoint and a relay stub on 127.0.0.1. `answerSimulations`: how many
 * simulateTransaction calls get an answer; later ones are accepted and never answered.
 */
export async function fakeNetwork(answerSimulations: number, relayAnswer: object, relayStatus = 502): Promise<Fake> {
  let sims = 0;
  let relays = 0;
  const open = new Set<import("node:net").Socket>();
  const rpcServer: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const call = JSON.parse(raw) as { id: number; method: string };
      if (call.method === "simulateTransaction") {
        sims += 1;
        if (sims > answerSimulations) return; // accepted, never answered
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: simulateAnswer() }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `fake rpc: ${call.method}` } }));
    });
  });
  const relayServer: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      relays += 1;
      res.writeHead(relayStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(relayAnswer));
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
    simulations: () => sims,
    relayCalls: () => relays,
    close: async () => {
      for (const sock of open) sock.destroy();
      await Promise.all([rpcServer, relayServer].map((s) => new Promise((r) => s.close(r))));
    },
  };
}

/** The real SmartAccountKit, pointed at the fake network, with only the passkey and context-rule lookup replaced. */
export function realKit(net: Fake): WriteKit {
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org", // the kit refuses http; its rpc is swapped below
    networkPassphrase: PASSPHRASE,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: net.relayUrl,
    indexerUrl: false,
  }) as unknown as Record<string, unknown>;
  kit.rpc = new rpc.Server(net.rpcUrl, { allowHttp: true });
  kit.rpcUrl = net.rpcUrl;
  kit._contractId = WALLET;
  kit._credentialId = "test-credential";
  kit.signAuthEntryInternal = async (entry: xdr.SorobanAuthorizationEntry) => entry; // the passkey prompt
  kit.resolveConnectedContextRuleIds = async () => undefined; // before the step under test
  return kit as unknown as WriteKit;
}

