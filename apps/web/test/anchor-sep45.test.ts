import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { checkChallenge, encodeEntries, signInToAnchor, type Sep45Deps } from "../src/lib/anchor/sep45";
import { AnchorError } from "../src/lib/anchor/errors";
import type { AnchorToml } from "../src/lib/anchor/toml";
import { TEST_SIGNING_KEY, signAsAnchor } from "./sep45-test-anchor";

// A challenge shaped exactly like the one testanchor.stellar.org returned on
// 2026-11-27 (decoded in docs/research/anchor-spike-2026-11-27.md): two
// web_auth_verify entries on the anchor's web auth contract, the wallet's
// unsigned and the anchor's signed.
const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
const OTHER_WALLET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SIGNING_KEY = TEST_SIGNING_KEY; // Codex cash-out R1 #2: the anchor's entry is signed (sep45-test-anchor.ts)
const CONTRACT = "CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX";
const TOML: AnchorToml = { signingKey: SIGNING_KEY, webAuthEndpoint: "https://testanchor.stellar.org/sep45/auth", transferServer: "https://testanchor.stellar.org/sep24", webAuthContract: CONTRACT };
const TOKEN = "SECRET-ANCHOR-TOKEN-do-not-leak";

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const str = (s: string) => xdr.ScVal.scvString(s);

type Over = { account?: string; contract?: string; fn?: string; domain?: string; signingKey?: string; subs?: boolean; signer?: string; extraArg?: boolean };
function entry(o: Over = {}): xdr.SorobanAuthorizationEntry {
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("account"), val: str(o.account ?? WALLET) }),
    new xdr.ScMapEntry({ key: sym("home_domain"), val: str(o.domain ?? "testanchor.stellar.org") }),
    new xdr.ScMapEntry({ key: sym("nonce"), val: str("2ba48f3a-d31c-4b98-b728-6b35ff7df6e1") }),
    new xdr.ScMapEntry({ key: sym("web_auth_domain"), val: str(o.domain ?? "testanchor.stellar.org") }),
    new xdr.ScMapEntry({ key: sym("web_auth_domain_account"), val: str(o.signingKey ?? SIGNING_KEY) }),
  ]);
  const inv = (fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[]) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(o.contract ?? CONTRACT).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: subs,
    });
  const e = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(o.signer ?? WALLET).toScAddress(), nonce: xdr.Int64.fromString("5"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: inv(o.fn ?? "web_auth_verify", o.extraArg ? [map, map] : [map], o.subs ? [inv("web_auth_verify", [map], [])] : []),
  });
  return (o.signer ?? WALLET) === SIGNING_KEY ? signAsAnchor(e) : e;
}
const challenge = (...es: xdr.SorobanAuthorizationEntry[]) => encodeEntries(es);
const good = () => challenge(entry(), entry({ signer: SIGNING_KEY }));

describe("SEP-45 challenge check (before the passkey is asked)", () => {
  it("accepts the anchor's real shape and finds the wallet's own entry", () => {
    const c = checkChallenge(good(), WALLET, TOML);
    expect(c.entries).toHaveLength(2);
    expect(c.own).toBe(0);
  });
  it("encodes entries so the same bytes read back (what the anchor parses)", () => {
    const back = xdr.SorobanAuthorizationEntries.fromXDR(good(), "base64");
    expect(back).toHaveLength(2);
    expect(encodeEntries([...back])).toBe(good());
  });
  const refusals: [string, string, RegExp][] = [
    ["a challenge for another wallet", challenge(entry({ account: OTHER_WALLET, signer: OTHER_WALLET }), entry({ account: OTHER_WALLET, signer: SIGNING_KEY })), /not addressed to your wallet/],
    ["no entry for the wallet", challenge(entry({ signer: SIGNING_KEY })), /not addressed to your wallet/],
    ["a different contract", challenge(entry({ contract: OTHER_WALLET }), entry({ signer: SIGNING_KEY })), /not for its sign-in contract/],
    ["a different function", challenge(entry({ fn: "transfer" }), entry({ signer: SIGNING_KEY })), /not for its sign-in contract/],
    ["an extra argument", challenge(entry({ extraArg: true }), entry({ signer: SIGNING_KEY })), /not for its sign-in contract/],
    ["a hidden sub-call", challenge(entry({ subs: true }), entry({ signer: SIGNING_KEY })), /more than a sign-in/],
    ["another domain", challenge(entry({ domain: "evil.example" }), entry({ signer: SIGNING_KEY })), /different wallet or domain/],
    ["another signing key", challenge(entry({ signingKey: OTHER_WALLET }), entry({ signer: SIGNING_KEY })), /different wallet or domain/],
    ["a wallet named in the map but signing for another", challenge(entry({ account: OTHER_WALLET }), entry({ signer: SIGNING_KEY })), /different wallet or domain/],
    ["two entries for the wallet", challenge(entry(), entry()), /not addressed to your wallet/],
  ];
  for (const [name, text, why] of refusals) {
    it(`refuses ${name}`, () => {
      expect(() => checkChallenge(text, WALLET, TOML)).toThrow(why);
    });
  }
  it("refuses text that is not entries", () => {
    expect(() => checkChallenge("AAAA", WALLET, TOML)).toThrow(/could not be read/);
  });
});

function fakeAnchor(over: { challengeStatus?: number; postStatus?: number; postBody?: unknown } = {}) {
  const posts: unknown[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(over.postBody ?? { token: TOKEN }), { status: over.postStatus ?? 200 });
    }
    expect(String(url)).toBe(`https://testanchor.stellar.org/sep45/auth?account=${WALLET}&home_domain=testanchor.stellar.org`);
    return new Response(JSON.stringify({ authorization_entries: good(), network_passphrase: "Test SDF Network ; September 2015" }), { status: over.challengeStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, posts };
}
function deps(fetchFn: typeof fetch, over: Partial<Sep45Deps> = {}): Sep45Deps {
  return {
    fetchFn,
    latestLedger: async () => 1000,
    // Stands in for the passkey: marks the entry as signed.
    signAuthEntry: vi.fn(async (e: xdr.SorobanAuthorizationEntry, o: { expiration: number }) => {
      const c = xdr.SorobanAuthorizationEntry.fromXDR(e.toXDR());
      c.credentials().address().signatureExpirationLedger(o.expiration);
      c.credentials().address().signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("signed-by-test-passkey")]));
      return c;
    }),
    ...over,
  };
}

describe("SEP-45 sign-in", () => {
  it("signs only the wallet's own entry, with a bounded expiry and rule 0, and returns the token", async () => {
    const { fetchFn, posts } = fakeAnchor();
    const d = deps(fetchFn);
    await expect(signInToAnchor(WALLET, TOML, d)).resolves.toBe(TOKEN);
    expect(d.signAuthEntry).toHaveBeenCalledTimes(1);
    expect(d.signAuthEntry).toHaveBeenCalledWith(expect.anything(), { expiration: 1100, contextRuleIds: [0] });
    const sent = xdr.SorobanAuthorizationEntries.fromXDR((posts[0] as { authorization_entries: string }).authorization_entries, "base64");
    expect(sent[0]!.credentials().address().signatureExpirationLedger()).toBe(1100);
    expect(sent[0]!.credentials().address().signature().switch().name).toBe("scvVec");
    // The anchor's entry goes back untouched.
    expect(sent[1]!.toXDR().toString("base64")).toBe(entry({ signer: SIGNING_KEY }).toXDR().toString("base64"));
  });
  it("never asks the passkey to sign a bad challenge", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ authorization_entries: challenge(entry({ contract: OTHER_WALLET }), entry({ signer: SIGNING_KEY })) }), { status: 200 })) as unknown as typeof fetch;
    const d = deps(bad);
    await expect(signInToAnchor(WALLET, TOML, d)).rejects.toThrow(/not for its sign-in contract/);
    expect(d.signAuthEntry).not.toHaveBeenCalled();
  });
  it("names each failure and never puts the token in an error", async () => {
    const cases: [Parameters<typeof fakeAnchor>[0], RegExp][] = [
      [{ challengeStatus: 500 }, /refused to start a sign-in.*500/],
      [{ postStatus: 401 }, /did not accept the signed sign-in.*401/],
      [{ postBody: { nope: 1 } }, /sent no token/],
    ];
    for (const [over, why] of cases) {
      const { fetchFn } = fakeAnchor(over);
      const err = await signInToAnchor(WALLET, TOML, deps(fetchFn)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AnchorError);
      expect((err as Error).message).toMatch(why);
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
  it("says so when the anchor cannot be reached", async () => {
    const down = (async () => {
      throw new TypeError("failed to fetch");
    }) as unknown as typeof fetch;
    await expect(signInToAnchor(WALLET, TOML, deps(down))).rejects.toThrow(/could not reach the test anchor/);
  });
  it("puts the token nowhere but the return value (no URL, no log)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const { fetchFn } = fakeAnchor();
    const spy = vi.fn((u: string | URL | Request, i?: RequestInit) => {
      seen.push(String(u));
      return (fetchFn as unknown as (u: unknown, i: unknown) => Promise<Response>)(u, i);
    }) as unknown as typeof fetch;
    await signInToAnchor(WALLET, TOML, deps(spy));
    expect(seen.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });
});
