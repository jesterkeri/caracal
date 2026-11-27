import { readFileSync } from "node:fs";
import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { beginCashout, sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { encodeEntries } from "../src/lib/anchor/sep45";
import { parseTransaction } from "../src/lib/anchor/sep24";
import type { AnchorToml } from "../src/lib/anchor/toml";

const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
const SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR";
const CONTRACT = "CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX";
const TOKEN = "SECRET-ANCHOR-TOKEN-do-not-leak";
const TOML: AnchorToml = { signingKey: SIGNING_KEY, webAuthEndpoint: "https://testanchor.stellar.org/sep45/auth", transferServer: "https://testanchor.stellar.org/sep24", webAuthContract: CONTRACT };
const TWO = BigInt(20_000_000);
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));

function challenge(): string {
  const arg = xdr.ScVal.scvMap(
    [
      ["account", WALLET],
      ["home_domain", "testanchor.stellar.org"],
      ["nonce", "n"],
      ["web_auth_domain", "testanchor.stellar.org"],
      ["web_auth_domain_account", SIGNING_KEY],
    ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k!), val: xdr.ScVal.scvString(v!) })),
  );
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

function anchor() {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET" });
    if (u.includes("/sep45/auth") && init?.method === "POST") return new Response(JSON.stringify({ token: TOKEN }));
    if (u.includes("/sep45/auth")) return new Response(JSON.stringify({ authorization_entries: challenge() }));
    return new Response(JSON.stringify({ id: "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef", url: "https://anchor-ref-ui-testanchor.stellar.org?transaction_id=2ea23fcd&token=short" }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("beginning a cash-out", () => {
  it("signs in, starts the withdraw, and sends nothing from the wallet", async () => {
    const { fetchFn, calls } = anchor();
    const sign = vi.fn(async (e: xdr.SorobanAuthorizationEntry) => e);
    const r = await beginCashout(WALLET, TOML, TWO, { fetchFn, signAuthEntry: sign, latestLedger: async () => 50 });
    expect(r).toMatchObject({ token: TOKEN, id: "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /sep45/auth", "POST /sep45/auth", "POST /sep24/transactions/withdraw/interactive"]);
    expect(calls.map((c) => c.url).join(" ")).not.toContain(TOKEN);
  });
  it("says the passkey prompt was cancelled and starts nothing", async () => {
    const { fetchFn, calls } = anchor();
    const cancelled = Object.assign(new Error("NotAllowedError"), { code: 4004 });
    await expect(beginCashout(WALLET, TOML, TWO, { fetchFn, signAuthEntry: async () => Promise.reject(cancelled), latestLedger: async () => 50 })).rejects.toThrow(/cancelled the passkey prompt.*Nothing was started/);
    expect(calls.some((c) => c.url.includes("/sep24/"))).toBe(false);
  });
  it("names a passkey failure without leaking its raw error", async () => {
    const { fetchFn } = anchor();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(beginCashout(WALLET, TOML, TWO, { fetchFn, signAuthEntry: async () => Promise.reject(new Error("boom")), latestLedger: async () => 50 })).rejects.toThrow(/passkey could not sign/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });
});

function sendDeps(over: Partial<SendDeps> = {}): SendDeps & { built: ReturnType<typeof vi.fn>; submitted: ReturnType<typeof vi.fn> } {
  const built = vi.fn(async () => ({ tx: "assembled" }));
  const submitted = vi.fn(async () => ({ success: true as const, hash: "cb718a83" }));
  return { buildTransfer: built, signAndSubmit: submitted, ...over, built, submitted } as never;
}

describe("sending the USDC", () => {
  it("sends exactly what the anchor quoted and was confirmed, once", async () => {
    const d = sendDeps();
    await expect(sendToAnchor(waiting, TWO, d)).resolves.toEqual({ kind: "sent", hash: "cb718a83" });
    expect(d.built).toHaveBeenCalledTimes(1);
    expect(d.built.mock.calls[0]![0]).toMatchObject({ stroops: TWO });
    expect(d.submitted).toHaveBeenCalledTimes(1);
  });
  it("sends nothing, and never asks for the passkey, when the anchor's request does not match", async () => {
    const d = sendDeps();
    const r = await sendToAnchor({ ...waiting, amountIn: "9" }, TWO, d);
    expect(r).toMatchObject({ kind: "not-sent" });
    expect(d.built).not.toHaveBeenCalled();
    expect(d.submitted).not.toHaveBeenCalled();
  });
  it("sends nothing when it cannot build the payment", async () => {
    const d = sendDeps({ buildTransfer: async () => Promise.reject(new Error("rpc down")) });
    const r = await sendToAnchor(waiting, TWO, d);
    expect(r).toMatchObject({ kind: "not-sent", message: expect.stringMatching(/Nothing was sent/) });
    expect((d.submitted as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
  it("reports a cancelled passkey prompt as not sent (thrown or returned)", async () => {
    const cancelled = Object.assign(new Error("x"), { code: 4004 });
    expect(await sendToAnchor(waiting, TWO, sendDeps({ signAndSubmit: async () => Promise.reject(cancelled) }))).toMatchObject({ kind: "not-sent", message: expect.stringMatching(/cancelled/) });
    expect(await sendToAnchor(waiting, TWO, sendDeps({ signAndSubmit: async () => ({ success: false, error: { code: 4004, message: "c" } }) }))).toMatchObject({ kind: "not-sent" });
  });
  it("calls a relay refusal that says 'Nothing was sent' not sent, and never claims success", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = "The fee relayer refused this transaction (POLICY). Nothing was sent.";
    const r = await sendToAnchor(waiting, TWO, sendDeps({ signAndSubmit: async () => ({ success: false, error: { code: 5003, message: refusal } }) }));
    expect(r).toMatchObject({ kind: "not-sent", message: expect.stringMatching(/Nothing left your wallet/) });
    log.mockRestore();
  });
  it("calls a failure that has a hash, a timeout, or a throw an UNKNOWN outcome and says not to send again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const withHash = await sendToAnchor(waiting, TWO, sendDeps({ signAndSubmit: async () => ({ success: false, hash: "abc", error: { code: 5003, message: "x" } }) }));
    expect(withHash).toMatchObject({ kind: "unknown", hash: "abc", message: expect.stringMatching(/Do not send it again/) });
    const timeout = await sendToAnchor(waiting, TWO, sendDeps({ signAndSubmit: async () => ({ success: false, error: { code: 5004, message: "t" } }) }));
    expect(timeout).toMatchObject({ kind: "unknown" });
    const threw = await sendToAnchor(waiting, TWO, sendDeps({ signAndSubmit: async () => Promise.reject(new Error("socket closed")) }));
    expect(threw).toMatchObject({ kind: "unknown", message: expect.stringMatching(/cannot tell whether it left your wallet/) });
    log.mockRestore();
  });
});
