// Adversary c4: smart-account-kit's signAuthEntry reads the chain BEFORE it asks for the passkey
// (the wallet's context rule 0 and the wallet's wasm hash). The cash-out sign-in hands that call the
// kit's own rpc with no deadline, and names any failure of it "Your passkey could not sign".
//
// Spec: docs/decisions.md 2026-11-27 (Cash-out, adversary c2): "the Stellar RPC calls on its path
// (the sign-in's latest ledger, ...) have the same 20 s limit as anchor requests; a failure is
// named as the network's, and only the passkey signing step is put down to the passkey". And
// goals 4 and 5: a wrong cause, and a page that hangs without bound.
// Cause: src/lib/anchor/sep45.ts signInToAnchor calls deps.signAuthEntry (page.tsx passes
// kit.signAuthEntry) with no `within`, and its catch blames the passkey for everything that is not
// code 4004. node_modules/smart-account-kit/dist/kit/webauthn-ops.js signAuthEntry runs
// findWebAuthnSignerInRules (rpc.simulateTransaction) and resolveAuthDigestScheme
// (rpc.getContractData) before startAuthentication; stellar-sdk's rpc.Server has no timeout.
//
// Real: the page, src/lib/anchor/*, smart-account-kit 0.10.0's real signAuthEntry, stellar-sdk's real
// rpc.Server against a 127.0.0.1 server that accepts and never answers. Faked: the anchor (the
// repo's captured fixtures), Supabase, the popup, and the kit's connected-wallet fields (set the
// way the c3 tests set them).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Networks, rpc } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET, mount, pressContinue, text, tick, unmock } from "./adversary-c2-harness";

const realSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
let hangServer: http.Server;
let hangUrl: string;
let requests = 0;
beforeAll(async () => {
  hangServer = http.createServer(() => {
    requests++; // accepts the request, never answers
  });
  await new Promise<void>((r) => hangServer.listen(0, "127.0.0.1", r));
  hangUrl = `http://127.0.0.1:${(hangServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  hangServer.closeAllConnections();
  await new Promise<void>((r) => hangServer.close(() => r()));
});
beforeEach(() => {
  requests = 0;
  vi.restoreAllMocks(); // test/setup-relay-server.ts stubs rpc.Server methods for every test; this one needs the real SDK
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); // sockets run in real time
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** The real kit, connected to the page's wallet; `chain` is what its own rpc answers. */
function realKit(chain: unknown) {
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://127.0.0.1:1/api/relay",
    storage: new MemoryStorage(),
    rpName: "Caracal",
  });
  const k = kit as unknown as Record<string, unknown>;
  k._contractId = WALLET;
  k._credentialId = "Y3JlZC0x"; // base64url of "cred-1"
  k.wallet = {}; // requireWallet() only needs it to exist
  k.rpc = chain;
  // The passkey prompt must never be reached in these tests: it would need a browser.
  (k.webAuthn as { startAuthentication: unknown }).startAuthentication = async () => {
    throw new Error("the passkey prompt was reached");
  };
  return kit;
}

describe("adversary c4: the kit's own chain reads inside signAuthEntry during the anchor sign-in", () => {
  it("control: the real kit really calls the chain before the passkey (this server sees the request)", async () => {
    const kit = realKit(new rpc.Server(hangUrl, { allowHttp: true }));
    const { rt } = await mount({ signAuthEntry: ((e: unknown, o: unknown) => kit.signAuthEntry(e as never, o as never)) as never });
    await pressContinue(rt);
    await realSleep(500); // real time: the kit's request reaches the server
    expect(requests).toBeGreaterThan(0);
    expect(text(rt)).toContain("Signing in to the anchor with your passkey...");
    rt.unmount();
  });

  it("a chain read that never answers does not leave the page on 'Signing in...' for ever", async () => {
    const kit = realKit(new rpc.Server(hangUrl, { allowHttp: true }));
    const { rt } = await mount({ signAuthEntry: ((e: unknown, o: unknown) => kit.signAuthEntry(e as never, o as never)) as never });
    await pressContinue(rt);
    await realSleep(500);
    expect(requests).toBeGreaterThan(0); // the kit is waiting on the chain, not on a passkey prompt
    await tick(10 * 60_000); // ten minutes of the page's own time
    expect(text(rt)).not.toContain("Signing in to the anchor with your passkey...");
    rt.unmount();
  });

  it("a chain read that fails is named as the network's, not put down to the passkey", async () => {
    const down = async () => {
      throw new Error("fetch failed");
    };
    const kit = realKit({ simulateTransaction: down, getContractData: down });
    const { rt } = await mount({ signAuthEntry: ((e: unknown, o: unknown) => kit.signAuthEntry(e as never, o as never)) as never });
    await pressContinue(rt);
    await realSleep(100);
    await tick(100);
    expect(text(rt)).toMatch(/Nothing was started/); // the page did stop and say so
    expect(text(rt)).not.toMatch(/passkey could not sign/i);
    rt.unmount();
  });
});
