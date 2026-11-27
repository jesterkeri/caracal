// Shared helpers for the live anchor scripts (testnet only, throwaway keys).
// A software P-256 key stands in for the passkey; signing uses smart-account-kit
// 0.10.0's own signAuthEntry, so the signature is what the kit builds in the browser.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { Address, Keypair, Networks, Operation, TransactionBuilder, authorizeEntry, hash, rpc, xdr } from "@stellar/stellar-sdk";

export const PASS = Networks.TESTNET;
export const ACCOUNT_WASM = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
export const VERIFIER = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";
export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const ANCHOR = "https://testanchor.stellar.org";
export const ORIGIN = "http://localhost:3000";
export const RP_ID = "localhost";
export const server = new rpc.Server("https://soroban-testnet.stellar.org");

const kitIndex = new URL(import.meta.resolve("smart-account-kit"));
const { signAuthEntry } = await import(new URL("kit/webauthn-ops.js", kitIndex).href);

export const b64url = (b) => Buffer.from(b).toString("base64url");
export const addr = (a) => xdr.ScVal.scvAddress(Address.fromString(a).toScAddress());
export const contractIdOf = (preimage) =>
  Address.contract(
    hash(xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(PASS)), contractIdPreimage: preimage })).toXDR()),
  ).toString();
export const randomNonce = () => xdr.Int64.fromString(BigInt.asIntN(64, BigInt("0x" + randomBytes(8).toString("hex"))).toString());
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh software passkey, as hex/PEM strings so it can be saved to a scratch file. */
export function newPasskey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub65 = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
    pub65: pub65.toString("hex"),
    credentialId: randomBytes(16).toString("hex"),
  };
}

const keyDataOf = (pk) => Buffer.concat([Buffer.from(pk.pub65, "hex"), Buffer.from(pk.credentialId, "hex")]);

function softAuthn(pk) {
  const privateKey = createPrivateKey(pk.privateKey);
  return {
    async startAuthentication({ optionsJSON }) {
      const authenticatorData = Buffer.concat([createHash("sha256").update(RP_ID).digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: optionsJSON.challenge, origin: ORIGIN, crossOrigin: false }));
      const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), privateKey);
      return {
        id: b64url(Buffer.from(pk.credentialId, "hex")),
        response: { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) },
      };
    },
  };
}

export async function fundG(kp) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
}

/** Submit one host function from a G account (the source), prepared via RPC simulation. */
export async function submit(source, hostFunc, auth = []) {
  const acct = await server.getAccount(source.publicKey());
  let tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASS })
    .addOperation(Operation.invokeHostFunction({ func: hostFunc, auth }))
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error("send failed " + JSON.stringify(sent.errorResult?.toXDR?.("base64")));
  for (let i = 0; i < 40; i++) {
    const g = await server.getTransaction(sent.hash);
    if (g.status === "SUCCESS") return { hash: sent.hash, result: g };
    if (g.status === "FAILED") throw new Error("tx failed " + sent.hash);
    await sleep(1500);
  }
  throw new Error("tx not confirmed in time " + sent.hash);
}

/** Deploy a passkey wallet straight to testnet (no relay). Returns its C address and the tx hash. */
export async function deployWallet(pk, payer) {
  const signerScVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), addr(VERIFIER), xdr.ScVal.scvBytes(keyDataOf(pk))]);
  const deployer = Keypair.fromRawEd25519Seed(createHash("sha256").update("openzeppelin-smart-account-kit").digest());
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(deployer.publicKey()).toScAddress(),
      salt: createHash("sha256").update(Buffer.from(pk.credentialId, "hex")).digest(),
    }),
  );
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: preimage,
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(ACCOUNT_WASM, "hex")),
    constructorArgs: [xdr.ScVal.scvVec([signerScVal]), xdr.ScVal.scvMap([])],
  });
  const { sequence } = await server.getLatestLedger();
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(deployer.publicKey()).toScAddress(), nonce: randomNonce(), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args),
      subInvocations: [],
    }),
  });
  const signed = await authorizeEntry(entry, deployer, sequence + 100, PASS);
  const r = await submit(payer, xdr.HostFunction.hostFunctionTypeCreateContractV2(args), [signed]);
  return { contractId: contractIdOf(preimage), hash: r.hash };
}

/** Sign one authorization entry of the wallet with the software passkey, through the kit's own signAuthEntry. */
export async function signWithPasskey(pk, walletId, entry, expiration) {
  const credentialId = b64url(Buffer.from(pk.credentialId, "hex"));
  const deps = {
    requireWallet: () => ({ wallet: null, contractId: walletId }),
    getCredentialId: () => credentialId,
    calculateExpiration: async () => expiration,
    resolveAuthDigestScheme: async () => "preimage-v1",
    networkPassphrase: PASS,
    rpId: RP_ID,
    webAuthn: softAuthn(pk),
    storage: { update: async () => {} },
  };
  return signAuthEntry(deps, entry, {
    expiration,
    credentialId,
    contextRuleIds: [0],
    signer: { tag: "External", values: [VERIFIER, keyDataOf(pk)] },
    authDigestScheme: "preimage-v1",
  });
}
