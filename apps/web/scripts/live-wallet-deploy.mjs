// Usage (from apps/web, server running): node scripts/live-wallet-deploy.mjs [relay URL]
// Live check: a passkey wallet deploy shaped like smart-account-kit 0.10.0's,
// sent to Caracal's /api/relay. The shared deployer seed is public by design.
import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
import { Address, Keypair, authorizeEntry, rpc, xdr, StrKey } from "@stellar/stellar-sdk";
const RELAY = process.argv[2] ?? "http://localhost:3000/api/relay";
const PASS = "Test SDF Network ; September 2015";
const ACCOUNT_WASM = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
const VERIFIER = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";
const deployer = Keypair.fromRawEd25519Seed(createHash("sha256").update("openzeppelin-smart-account-kit").digest());
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub65 = publicKey.export({ format: "der", type: "spki" }).subarray(-65); // uncompressed 0x04||X||Y
const credentialId = randomBytes(16);
const keyData = Buffer.concat([pub65, credentialId]); // kit appends the credential id
const signer = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), new Address(VERIFIER).toScVal(), xdr.ScVal.scvBytes(keyData)]);
const args = new xdr.CreateContractArgsV2({
  contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer.publicKey()).toScAddress(), salt: createHash("sha256").update(credentialId).digest() })),
  executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(ACCOUNT_WASM, "hex")),
  constructorArgs: [xdr.ScVal.scvVec([signer]), xdr.ScVal.scvMap([])],
});
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const { sequence } = await server.getLatestLedger();
const entry = new xdr.SorobanAuthorizationEntry({
  credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: Address.fromString(deployer.publicKey()).toScAddress(), nonce: xdr.Int64.fromString(BigInt.asIntN(64, BigInt("0x" + randomBytes(8).toString("hex"))).toString()), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })),
  rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args), subInvocations: [] }),
});
const signed = await authorizeEntry(entry, deployer, sequence + 60, PASS);
const body = { func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"), auth: [signed.toXDR("base64")] };
const t0 = Date.now();
const r = await fetch(RELAY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log("relay", r.status, (await r.text()).slice(0, 400), `${Date.now() - t0}ms`);
