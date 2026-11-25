import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkPayload, readBounded, WindowLimiter, clientKey } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { rpcWasmLookup } from "../src/lib/relay/wasm-lookup";
import { NETWORK, SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { argsFor, ctorFor, lookupInstance } from "./relay-fixtures";

// Real testnet ids (README / contracts/split/README.md).
const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT_ID = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const OLD_SPLIT_ID = "CB2WIGKDHY542ZLLQQPK7JB2ZN2NL25JLQT7YADWEWMEAHDXFWCFLGQ2";
const OLD_SPLIT_HASH = "24d6dafcf0d0204ce0437071191562003bc4fea039fc92ee5746c10e30ccaf13";
const RELAYER_G = "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX";

const POLICY = CARACAL_POLICY;

const fakeChain: Record<string, string | null> = {
  [SPLIT_ID]: SPLIT.wasmHash,
  [WALLET]: SMART_ACCOUNT.accountWasmHash,
  [OLD_SPLIT_ID]: OLD_SPLIT_HASH,
};
const lookup = async (id: string) => (id in fakeChain ? fakeChain[id]! : null);

function invokeArgs(contract: string, fn: string) {
  return new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contract).toScAddress(),
    functionName: fn,
    args: argsFor(fn),
  });
}
const invoke = (contract: string, fn: string) =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs(contract, fn)).toXDR("base64");

const createArgs = (wasmHex: string) =>
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(WALLET).toScAddress(),
          salt: Buffer.alloc(32, 1),
        }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHex, "hex")),
      constructorArgs: ctorFor(wasmHex),
    });
const create = (wasmHex: string) =>
  xdr.HostFunction.hostFunctionTypeCreateContractV2(createArgs(wasmHex)).toXDR("base64");
/** The wallet authorising exactly this deployment. */
const createAuth = (wasmHex: string) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString("8"),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(createArgs(wasmHex)),
      subInvocations: [],
    }),
  }).toXDR("base64");

function addressAuth(contract = SPLIT_ID, fn = "deposit") {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        invokeArgs(contract, fn),
      ),
      subInvocations: [],
    }),
  }).toXDR("base64");
}
function sourceAuth() {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        invokeArgs(TOKENS.xlm, "transfer"),
      ),
      subInvocations: [],
    }),
  }).toXDR("base64");
}

const check = (body: unknown) => checkPayload(body, POLICY, lookup, lookupInstance);

describe("relay sponsorship policy", () => {
  it("accepts a deposit into a Caracal split contract", async () => {
    const v = await check({ func: invoke(SPLIT_ID, "deposit"), auth: [addressAuth()] });
    expect(v.ok).toBe(true);
  });

  it("accepts a passkey account deploy and a split deploy", async () => {
    for (const h of [SMART_ACCOUNT.accountWasmHash, SPLIT.wasmHash]) {
      const v = await check({ func: create(h), auth: [createAuth(h)] });
      expect(v.ok).toBe(true);
    }
  });

  it("accepts USDC transfer, refuses other USDC functions", async () => {
    expect((await check({ func: invoke(TOKENS.usdc, "transfer"), auth: [addressAuth()] })).ok).toBe(true);
    const v = await check({ func: invoke(TOKENS.usdc, "approve"), auth: [addressAuth()] });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses the XLM SAC and unknown contracts", async () => {
    for (const c of [TOKENS.xlm, "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F"]) {
      const v = await check({ func: invoke(c, "transfer"), auth: [addressAuth()] });
      expect(v).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("refuses the superseded split contract (old wasm)", async () => {
    const v = await check({ func: invoke(OLD_SPLIT_ID, "deposit"), auth: [addressAuth()] });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses deploying wasm that is not on the allowlist", async () => {
    const v = await check({ func: create(OLD_SPLIT_HASH), auth: [createAuth(OLD_SPLIT_HASH)] });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses uploading wasm", async () => {
    const func = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from([0, 97, 115, 109])).toXDR("base64");
    expect(await check({ func, auth: [addressAuth()] })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses empty auth", async () => {
    expect(await check({ func: invoke(SPLIT_ID, "deposit"), auth: [] })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses source-account credentials, which would make the relayer the signer", async () => {
    const v = await check({ func: invoke(SPLIT_ID, "deposit"), auth: [addressAuth(), sourceAuth()] });
    expect(v).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses the { xdr } shape, extra keys, junk XDR and non-objects", async () => {
    const good = { func: invoke(SPLIT_ID, "deposit"), auth: [addressAuth()] };
    for (const b of [
      { xdr: "AAAA" },
      { ...good, extra: 1 },
      { func: "not-xdr", auth: [addressAuth()] },
      { func: good.func, auth: ["not-xdr"] },
      { func: good.func, auth: [42] },
      { func: good.func, auth: Array(9).fill(addressAuth()) },
      [good.func],
      null,
      "x",
    ]) {
      expect((await check(b)).ok).toBe(false);
    }
  });

  it("returns 503 when the wasm lookup fails, rather than forwarding", async () => {
    const v = await checkPayload({ func: invoke(SPLIT_ID, "deposit"), auth: [addressAuth()] }, POLICY, async () => {
      throw new Error("rpc down");
    });
    expect(v).toMatchObject({ ok: false, status: 503 });
  });

  it("refuses an account (G) address as a call target", async () => {
    // A G address cannot be an InvokeContract target in XDR terms, but guard anyway.
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(RELAYER_G).toScAddress(),
        functionName: "transfer",
        args: [],
      }),
    ).toXDR("base64");
    expect(await check({ func, auth: [addressAuth()] })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("readBounded", () => {
  const MAX = 1024;
  it("reads a body under the limit", async () => {
    const r = new Request("http://x/", { method: "POST", body: "a".repeat(MAX) });
    expect(await readBounded(r, MAX)).toBe("a".repeat(MAX));
  });

  it("refuses a declared content-length over the limit without reading", async () => {
    const r = new Request("http://x/", {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX + 1) },
    });
    expect(await readBounded(r, MAX)).toBeNull();
  });

  it("stops a streamed body with no length once it passes the limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(512));
        if (pulled > 1000) c.close();
      },
    });
    const r = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readBounded(r, MAX)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });
});

describe("WindowLimiter", () => {
  it("allows `limit` hits per window per key, then resets", () => {
    const l = new WindowLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => l.take("ip", 0))).toEqual([true, true, true, false]);
    expect(l.take("other", 0)).toBe(true);
    expect(l.take("ip", 1000)).toBe(true);
  });

  it("refuses new keys when full of live keys, then sweeps expired ones", () => {
    const l = new WindowLimiter(1, 1000, 2);
    expect(l.take("a", 0)).toBe(true);
    expect(l.take("b", 0)).toBe(true);
    expect(l.take("c", 10)).toBe(false);
    expect(l.take("c", 1000)).toBe(true);
  });
});

// Hits the real testnet RPC. Run with CARACAL_NETWORK_TESTS=1.
describe.runIf(process.env.CARACAL_NETWORK_TESTS === "1")("rpcWasmLookup on testnet", () => {
  const live = rpcWasmLookup(NETWORK.rpcUrl);
  it("reads the wasm hash of the deployed split contract and the passkey wallet", async () => {
    expect(await live(SPLIT_ID)).toBe(SPLIT.wasmHash);
    expect(await live(WALLET)).toBe(SMART_ACCOUNT.accountWasmHash);
  }, 30_000);
  it("returns null for the USDC SAC (no wasm)", async () => {
    expect(await live(TOKENS.usdc)).toBeNull();
  }, 30_000);
});
