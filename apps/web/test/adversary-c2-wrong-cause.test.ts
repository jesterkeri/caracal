// Adversary c2: a sign-in failure that is not the passkey's is reported as the passkey's.
//
// src/lib/anchor/flow.ts beginCashout(): any error that is not an AnchorError and not a cancelled
// prompt (code 4004) becomes "Your passkey could not sign the anchor's sign-in. Nothing was
// started. Try again." That text is wrong for at least two causes the passkey has nothing to do
// with: the Stellar RPC being unreachable when the sign-in asks for the latest ledger
// (deps.latestLedger(), run before the passkey is asked), and an anchor challenge whose argument
// is not a map, which makes checkChallenge() throw a TypeError (scValToNative returns null and
// `a.account` is read on it). Goal 4: a wrong cause for a failure. Nothing is signed in either case.
import { Address, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginCashout } from "../src/lib/anchor/flow";
import { AnchorError } from "../src/lib/anchor/errors";
import { checkChallenge, encodeEntries } from "../src/lib/anchor/sep45";
import { readToml } from "../src/lib/anchor/toml";
import { CONTRACT, SIGNING_KEY, WALLET, challenge, fixture } from "./adversary-c2-harness";

const toml = readToml(fixture("stellar.toml"));
const AMOUNT = BigInt(20_000_000);

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const answering = (entries: string): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/sep45/auth") && init?.method === "POST") return new Response(JSON.stringify({ token: "TOK" }));
    if (u.includes("/sep45/auth")) return new Response(JSON.stringify({ authorization_entries: entries }));
    if (u.includes("/withdraw/interactive")) return new Response(JSON.stringify({ id: "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef", url: "https://anchor-ref-ui-testanchor.stellar.org?x=1" }));
    return new Response("nf", { status: 404 });
  }) as typeof fetch;

/** The challenge with the one argument of web_auth_verify replaced by `arg`, for both entries. */
function challengeWithArg(arg: xdr.ScVal): string {
  const mk = (signer: string) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("5"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: Address.fromString(CONTRACT).toScAddress(), functionName: "web_auth_verify", args: [arg] }),
        ),
        subInvocations: [],
      }),
    });
  return encodeEntries([mk(WALLET), mk(SIGNING_KEY)]);
}

describe("adversary c2: the wrong cause is named for a sign-in failure", () => {
  it("control: a cancelled passkey prompt is reported as a cancelled prompt, and the happy path signs in", async () => {
    const signAuthEntry = vi.fn(async (e: xdr.SorobanAuthorizationEntry) => e);
    const ok = await beginCashout(WALLET, toml, AMOUNT, { fetchFn: answering(challenge()), signAuthEntry, latestLedger: async () => 100 });
    expect(ok.token).toBe("TOK");
    expect(signAuthEntry).toHaveBeenCalledTimes(1);
    const cancelled = await beginCashout(WALLET, toml, AMOUNT, {
      fetchFn: answering(challenge()),
      signAuthEntry: async () => {
        throw Object.assign(new Error("cancelled"), { code: 4004 });
      },
      latestLedger: async () => 100,
    }).catch((e: unknown) => e as Error);
    expect((cancelled as Error).message).toMatch(/cancelled the passkey prompt/);
  });

  it("an unreachable Stellar RPC (latest ledger fails, no passkey prompt yet) is not blamed on the passkey", async () => {
    const signAuthEntry = vi.fn();
    const e = (await beginCashout(WALLET, toml, AMOUNT, {
      fetchFn: answering(challenge()),
      signAuthEntry,
      latestLedger: async () => {
        throw new Error("fetch failed");
      },
    }).catch((x: unknown) => x)) as Error;
    expect(signAuthEntry).not.toHaveBeenCalled(); // the passkey was never asked
    expect(e).toBeInstanceOf(AnchorError);
    expect(e.message).not.toMatch(/passkey/i);
  });

  it("an anchor challenge whose argument is not a map is refused as the anchor's, not crashed on", () => {
    // scValToNative(void) is null, and checkChallenge reads `.account` on it.
    const bad = challengeWithArg(xdr.ScVal.scvVoid());
    let thrown: unknown;
    try {
      checkChallenge(bad, WALLET, toml);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AnchorError);
  });

  it("the same malformed challenge, through beginCashout, is not reported as a passkey failure", async () => {
    const signAuthEntry = vi.fn();
    const e = (await beginCashout(WALLET, toml, AMOUNT, { fetchFn: answering(challengeWithArg(xdr.ScVal.scvVoid())), signAuthEntry, latestLedger: async () => 100 }).catch((x: unknown) => x)) as Error;
    expect(signAuthEntry).not.toHaveBeenCalled();
    expect(e.message).not.toMatch(/passkey could not sign/i);
  });
});
