// Adversary c9: an anchor challenge whose own (wallet) entry already carries a signature is blamed on the
// Stellar network.
//
// Spec: docs/decisions.md 2026-11-27 (Cash-out, adversary c2/c4): "only the passkey signing step is put down
// to the passkey; a malformed anchor challenge is refused as the anchor's", and "anything else [than a passkey
// error] is named as the network". SEP-45: the client's entry is handed over unsigned (signature void).
// Goal 4: a wrong cause.
// Cause: src/lib/anchor/sep45.ts checkChallenge() never looks at the credentials' `signature` field of the
// wallet's entry. smart-account-kit 0.10.0's signAuthEntry (kit/webauthn-ops.js) then runs
// readAuthPayload(credentials.signature()) BEFORE it reads the chain or asks for the passkey, and throws
// "Smart account auth signature is not encoded as AuthPayload". signInToAnchor() sees an error that is
// neither a cancel nor a passkey error and tells the person "usually because the Stellar network could not
// be read ... Check your connection", although the network was never touched and nothing is wrong with
// their connection: the anchor's challenge was malformed.
//
// Real: src/lib/anchor/* and smart-account-kit 0.10.0's real signAuthEntry. Faked: the anchor (a fetch stub
// answering the repo's challenge with one field changed), the kit's connected-wallet fields (as in
// adversary-c4-kit-rpc-reads.test.ts), and the chain, which COUNTS the calls it receives so "the network was
// never read" is observed, not assumed.
import { Address, Networks, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginCashout } from "../src/lib/anchor/flow";
import { encodeEntries } from "../src/lib/anchor/sep45";
import { readToml } from "../src/lib/anchor/toml";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { CONTRACT, ID, SIGNING_KEY, WALLET, fixture } from "./adversary-c2-harness";
import { signAsAnchor, withTestKey } from "./sep45-test-anchor";

const toml = readToml(withTestKey(fixture("stellar.toml")));
const AMOUNT = BigInt(20_000_000);

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

/** The anchor's challenge (as the repo's harness builds it) with the wallet's entry carrying `signature`. */
function challengeWithWalletSignature(signature: xdr.ScVal): string {
  const arg = xdr.ScVal.scvMap(
    [
      ["account", WALLET],
      ["home_domain", "testanchor.stellar.org"],
      ["nonce", "n"],
      ["web_auth_domain", "testanchor.stellar.org"],
      ["web_auth_domain_account", SIGNING_KEY],
    ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k!), val: xdr.ScVal.scvString(v!) })),
  );
  const mk = (signer: string, sig: xdr.ScVal) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("5"), signatureExpirationLedger: 0, signature: sig }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: Address.fromString(CONTRACT).toScAddress(), functionName: "web_auth_verify", args: [arg] }),
        ),
        subInvocations: [],
      }),
    });
  return encodeEntries([mk(WALLET, signature), signAsAnchor(mk(SIGNING_KEY, xdr.ScVal.scvVoid()))]);
}

const anchor = (entries: string): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/sep45/auth") && init?.method === "POST") return new Response(JSON.stringify({ token: "TOK" }));
    if (u.includes("/sep45/auth")) return new Response(JSON.stringify({ authorization_entries: entries }));
    if (u.includes("/withdraw/interactive")) return new Response(JSON.stringify({ id: ID, url: "https://anchor-ref-ui-testanchor.stellar.org?x=1" }));
    return new Response("nf", { status: 404 });
  }) as typeof fetch;

/** The real kit, connected to the page's wallet; every call its rpc receives is counted, and fails like an unreachable network. */
function realKit() {
  const chainCalls: string[] = [];
  const down = (name: string) => async () => {
    chainCalls.push(name);
    throw new Error("fetch failed");
  };
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
  k.rpc = new Proxy({}, { get: (_t, name) => down(String(name)) });
  // The passkey prompt must never be reached in these tests: it would need a browser.
  (k.webAuthn as { startAuthentication: unknown }).startAuthentication = async () => {
    throw new Error("the passkey prompt was reached");
  };
  return { kit, chainCalls };
}

const signIn = async (entries: string, kit: SmartAccountKit): Promise<Error> => {
  try {
    await beginCashout(WALLET, toml, AMOUNT, {
      fetchFn: anchor(entries),
      signAuthEntry: (e, o) => kit.signAuthEntry(e, o),
      latestLedger: async () => 100,
    });
  } catch (x) {
    return x as Error;
  }
  throw new Error("the sign-in unexpectedly succeeded");
};

describe("adversary c9: the wallet's entry arrives already signed", () => {
  it("control: with an unsigned entry and a chain that cannot be read, the network is named (and the chain was really called)", async () => {
    const { kit, chainCalls } = realKit();
    const e = await signIn(challengeWithWalletSignature(xdr.ScVal.scvVoid()), kit);
    expect(chainCalls.length).toBeGreaterThan(0); // the harness works: the real kit reaches the chain before the passkey
    expect(e.message).toMatch(/Stellar network could not be read/);
  });

  it("an entry whose signature field is not an AuthPayload is refused as the anchor's, not blamed on the network", async () => {
    const { kit, chainCalls } = realKit();
    const e = await signIn(challengeWithWalletSignature(xdr.ScVal.scvBool(true)), kit);
    expect(chainCalls).toEqual([]); // the kit failed before reading the chain: the network is not involved at all
    expect(e.message).toMatch(/Nothing was (started|signed)/); // the page did stop and say so
    expect(e.message).not.toMatch(/Stellar network|connection/i); // today: "usually because the Stellar network could not be read ... Check your connection"
  });
});
