// Codex r2 findings 1, 2 and 7 on the relay sponsorship policy.
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { checkPayload, clientKey } from "../src/lib/relay/policy";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { argsFor, ctorFor, lookupInstance } from "./relay-fixtures";

// Real testnet ids.
const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT_ID = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
// Soroswap testnet router: a real contract that is not on the allowlist.
const OUTSIDER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const OUTSIDER_HASH = "ab".repeat(32);

const chain: Record<string, string> = {
  [WALLET]: SMART_ACCOUNT.accountWasmHash,
  [SPLIT_ID]: SPLIT.wasmHash,
  [OUTSIDER]: OUTSIDER_HASH,
};
const lookup = async (id: string) => chain[id] ?? null;
const check = (body: unknown) => checkPayload(body, CARACAL_POLICY, lookup, lookupInstance);

const callArgs = (contract: string, fn: string, args: xdr.ScVal[] = argsFor(fn)) =>
  new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contract).toScAddress(),
    functionName: fn,
    args,
  });
const invoke = (contract: string, fn: string, args: xdr.ScVal[] = argsFor(fn)) =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(callArgs(contract, fn, args)).toXDR("base64");

const executeArgs = (target: string, fn: string, inner: xdr.ScVal[] = argsFor(fn)) => [
  nativeToScVal(Address.fromString(target)),
  xdr.ScVal.scvSymbol(fn),
  xdr.ScVal.scvVec(inner),
];

type Node = { contract: string; fn: string; args?: xdr.ScVal[]; subs?: Node[] } | { deploy: string; v1?: boolean };

function inv(n: Node): xdr.SorobanAuthorizedInvocation {
  if ("deploy" in n) {
    const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: Address.fromString(WALLET).toScAddress(),
        salt: Buffer.alloc(32, 2),
      }),
    );
    const exe = xdr.ContractExecutable.contractExecutableWasm(Buffer.from(n.deploy, "hex"));
    const fn = n.v1
      ? xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({ contractIdPreimage: preimage, executable: exe }),
        )
      : xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
          new xdr.CreateContractArgsV2({ contractIdPreimage: preimage, executable: exe, constructorArgs: ctorFor(n.deploy) }),
        );
    return new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] });
  }
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      callArgs(n.contract, n.fn, n.args ?? argsFor(n.fn)),
    ),
    subInvocations: (n.subs ?? []).map(inv),
  });
}

const creds = () =>
  new xdr.SorobanAddressCredentials({
    address: Address.fromString(WALLET).toScAddress(),
    nonce: xdr.Int64.fromString("9"),
    signatureExpirationLedger: 1000,
    signature: xdr.ScVal.scvVoid(),
  });

function auth(root: Node, kind: "v1" | "v2" | "delegates" = "v1"): string {
  const c =
    kind === "v1"
      ? xdr.SorobanCredentials.sorobanCredentialsAddress(creds())
      : kind === "v2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(creds())
        : xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
            new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials: creds(), delegates: [] }),
          );
  return new xdr.SorobanAuthorizationEntry({ credentials: c, rootInvocation: inv(root) }).toXDR("base64");
}

const deposit: Node = {
  contract: SPLIT_ID,
  fn: "deposit",
  subs: [{ contract: TOKENS.usdc, fn: "transfer" }],
};

describe("finding 1: allowlist by function, through execute and the whole auth tree", () => {
  it("regression: split deposit whose auth tree includes the USDC transfer is sponsored", async () => {
    expect((await check({ func: invoke(SPLIT_ID, "deposit"), auth: [auth(deposit)] })).ok).toBe(true);
  });

  it("wallet execute -> outsider contract is refused", async () => {
    const args = executeArgs(OUTSIDER, "swap_exact_tokens_for_tokens");
    const v = await check({
      func: invoke(WALLET, "execute", args),
      auth: [auth({ contract: WALLET, fn: "execute", args })],
    });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("wallet execute -> split deposit is sponsored", async () => {
    const args = executeArgs(SPLIT_ID, "deposit");
    const v = await check({
      func: invoke(WALLET, "execute", args),
      auth: [auth({ contract: WALLET, fn: "execute", args, subs: [deposit] })],
    });
    expect(v.ok).toBe(true);
  });

  it("wallet execute -> USDC approve is refused", async () => {
    const args = executeArgs(TOKENS.usdc, "approve");
    expect(
      await check({ func: invoke(WALLET, "execute", args), auth: [auth({ contract: WALLET, fn: "execute", args })] }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("nested execute is refused", async () => {
    const args = executeArgs(WALLET, "execute", executeArgs(SPLIT_ID, "deposit"));
    expect(
      await check({ func: invoke(WALLET, "execute", args), auth: [auth({ contract: WALLET, fn: "execute", args })] }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("malformed execute arguments are refused", async () => {
    const bad = [xdr.ScVal.scvSymbol("x"), xdr.ScVal.scvSymbol("deposit"), xdr.ScVal.scvVec([])];
    expect((await check({ func: invoke(WALLET, "execute", bad), auth: [auth(deposit)] })).ok).toBe(false);
  });

  it("wallet admin functions are refused (add_signer, upgrade)", async () => {
    for (const fn of ["add_signer", "upgrade", "add_context_rule"]) {
      expect(
        await check({ func: invoke(WALLET, fn), auth: [auth({ contract: WALLET, fn })] }),
      ).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("split functions outside the list are refused", async () => {
    for (const fn of ["config", "balances", "__constructor", "anything"]) {
      expect((await check({ func: invoke(SPLIT_ID, fn), auth: [auth(deposit)] })).ok).toBe(false);
    }
  });

  it("an allowed top-level call with an outsider hidden in the auth tree is refused", async () => {
    const tree: Node = { ...deposit, subs: [{ contract: OUTSIDER, fn: "anything" }] };
    expect(await check({ func: invoke(SPLIT_ID, "deposit"), auth: [auth(tree)] })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("an XLM transfer hidden in the auth tree is refused", async () => {
    const tree: Node = { ...deposit, subs: [{ contract: TOKENS.xlm, fn: "transfer" }] };
    expect((await check({ func: invoke(SPLIT_ID, "deposit"), auth: [auth(tree)] })).ok).toBe(false);
  });

  it("auth deploys: allowlisted wasm via V2 is fine, v1 or other wasm is refused", async () => {
    const func = invoke(SPLIT_ID, "deposit");
    expect((await check({ func, auth: [auth({ deploy: SMART_ACCOUNT.accountWasmHash })] })).ok).toBe(true);
    expect((await check({ func, auth: [auth({ deploy: SMART_ACCOUNT.accountWasmHash, v1: true })] })).ok).toBe(false);
    expect((await check({ func, auth: [auth({ deploy: OUTSIDER_HASH })] })).ok).toBe(false);
  });

  it("a huge auth tree is refused", async () => {
    const wide: Node = { ...deposit, subs: Array(40).fill({ contract: TOKENS.usdc, fn: "transfer" }) };
    expect(await check({ func: invoke(SPLIT_ID, "deposit"), auth: [auth(wide)] })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("finding 7: address credential variants", () => {
  it("accepts AddressV2 credentials", async () => {
    expect((await check({ func: invoke(SPLIT_ID, "deposit"), auth: [auth(deposit, "v2")] })).ok).toBe(true);
  });
  it("refuses AddressWithDelegates (the wallet kit does not sign them)", async () => {
    expect(
      await check({ func: invoke(SPLIT_ID, "deposit"), auth: [auth(deposit, "delegates")] }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("finding 2: rate-limit key trusts forwarded headers only behind a trusted proxy", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { method: "POST", headers: h });
  it("ignores x-forwarded-for on an untrusted host, so rotating it gains nothing", () => {
    expect(clientKey(req({ "x-forwarded-for": "1.1.1.1" }), {})).toBe("untrusted-proxy");
    expect(clientKey(req({ "x-forwarded-for": "2.2.2.2" }), {})).toBe("untrusted-proxy");
  });
  it("uses the first forwarded address on Vercel or a configured trusted proxy", () => {
    expect(clientKey(req({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }), { VERCEL: "1" })).toBe("1.1.1.1");
    expect(clientKey(req({ "x-real-ip": "3.3.3.3" }), { RELAY_TRUSTED_PROXY: "1" })).toBe("3.3.3.3");
  });
});
