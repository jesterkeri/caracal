// Usage (from apps/web, server running with CHANNELS_API_KEY set):
//   node scripts/live-channels-payment-path.mjs [relay URL]
// Live check of the payment path: Caracal's relay builds, simulates (signatures
// enforced), pins and signs the transaction, and OpenZeppelin Channels
// fee-bumps it, through the official client.
// 1. Deploy a fresh passkey wallet through the relay (proxy path).
// 2. That wallet deploys its own split contract (owner = the wallet). The wallet
//    authorises it, so the relay sends it through Channels.
// The passkey is a software P-256 key standing in for a phone's authenticator;
// signing uses smart-account-kit 0.10.0's own signAuthEntry, so the signature
// is what the kit builds in the browser. Testnet only; keys live in memory.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { Address, Keypair, authorizeEntry, hash, rpc, xdr } from "@stellar/stellar-sdk";

const RELAY = process.argv[2] ?? "http://localhost:3000/api/relay";
const PASS = "Test SDF Network ; September 2015";
const ACCOUNT_WASM = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
const SPLIT_WASM = "ca6befd2b75c60ef2b3019667c11e26e675364aa4b0380783d8589b62d07f56c";
const VERIFIER = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ORIGIN = "http://localhost:3000";
const RP_ID = "localhost";

const kitIndex = new URL(import.meta.resolve("smart-account-kit"));
const { signAuthEntry } = await import(new URL("kit/webauthn-ops.js", kitIndex).href);

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const b64url = (b) => Buffer.from(b).toString("base64url");
const addr = (a) => xdr.ScVal.scvAddress(Address.fromString(a).toScAddress());
const contractIdOf = (preimage) =>
  Address.contract(hash(xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(PASS)), contractIdPreimage: preimage })).toXDR())).toString();
const randomNonce = () => xdr.Int64.fromString(BigInt.asIntN(64, BigInt("0x" + randomBytes(8).toString("hex"))).toString());
async function relay(label, body) {
  const t0 = Date.now();
  const r = await fetch(RELAY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  console.log(label, r.status, text.slice(0, 400), `${Date.now() - t0}ms`);
  if (!r.ok) process.exit(1);
  return JSON.parse(text);
}

// The software passkey.
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub65 = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
const credentialId = randomBytes(16);
const keyData = Buffer.concat([pub65, credentialId]);
const signerScVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), addr(VERIFIER), xdr.ScVal.scvBytes(keyData)]);
const webAuthn = {
  async startAuthentication({ optionsJSON }) {
    const authenticatorData = Buffer.concat([createHash("sha256").update(RP_ID).digest(), Buffer.from([0x05]), Buffer.alloc(4)]); // UP | UV
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: optionsJSON.challenge, origin: ORIGIN, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), privateKey);
    return { id: b64url(credentialId), response: { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) } };
  },
};

// 1. Deploy the wallet from the kit's shared deployer (seed public by design).
const deployer = Keypair.fromRawEd25519Seed(createHash("sha256").update("openzeppelin-smart-account-kit").digest());
const walletPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
  new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer.publicKey()).toScAddress(), salt: createHash("sha256").update(credentialId).digest() }),
);
const walletArgs = new xdr.CreateContractArgsV2({
  contractIdPreimage: walletPreimage,
  executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(ACCOUNT_WASM, "hex")),
  constructorArgs: [xdr.ScVal.scvVec([signerScVal]), xdr.ScVal.scvMap([])],
});
const WALLET = contractIdOf(walletPreimage);
let { sequence } = await server.getLatestLedger();
const deployEntry = new xdr.SorobanAuthorizationEntry({
  credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: Address.fromString(deployer.publicKey()).toScAddress(), nonce: randomNonce(), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })),
  rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(walletArgs), subInvocations: [] }),
});
const signedDeploy = await authorizeEntry(deployEntry, deployer, sequence + 60, PASS);
console.log("wallet", WALLET);
await relay("wallet deploy (proxy path)", { func: xdr.HostFunction.hostFunctionTypeCreateContractV2(walletArgs).toXDR("base64"), auth: [signedDeploy.toXDR("base64")] });

// 2. The wallet deploys its own split contract: (owner, token, tax_bps, goal_bps).
const splitPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
  new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: createHash("sha256").update("caracal-split-v1").digest() }),
);
const splitArgs = new xdr.CreateContractArgsV2({
  contractIdPreimage: splitPreimage,
  executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT_WASM, "hex")),
  constructorArgs: [addr(WALLET), addr(USDC), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)],
});
({ sequence } = await server.getLatestLedger());
const splitEntry = new xdr.SorobanAuthorizationEntry({
  credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: randomNonce(), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })),
  rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(splitArgs), subInvocations: [] }),
});
const deps = {
  requireWallet: () => ({ wallet: null, contractId: WALLET }),
  getCredentialId: () => b64url(credentialId),
  calculateExpiration: async () => sequence + 60,
  resolveAuthDigestScheme: async () => "preimage-v1",
  networkPassphrase: PASS,
  rpId: RP_ID,
  webAuthn,
  storage: { update: async () => {} },
};
const signedSplit = await signAuthEntry(deps, splitEntry, {
  expiration: sequence + 60,
  credentialId: b64url(credentialId),
  contextRuleIds: [0],
  signer: { tag: "External", values: [VERIFIER, keyData] },
  authDigestScheme: "preimage-v1",
});
const SPLIT_ID = contractIdOf(splitPreimage);
console.log("split", SPLIT_ID);
const out = await relay("split deploy (Channels path)", { func: xdr.HostFunction.hostFunctionTypeCreateContractV2(splitArgs).toXDR("base64"), auth: [signedSplit.toXDR("base64")] });
console.log("channels tx", out.data?.hash);
