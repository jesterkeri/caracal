// Public Stellar testnet configuration. Nothing here is secret.
// Sources: docs/research/verify-2026-11-25.md and the smart-account-kit
// testnet deployment manifest (stellar-accounts v0.8.0, 2026-10-25).

export const NETWORK = {
  name: "testnet",
  passphrase: "Test SDF Network ; September 2015",
  // `||`, not `??`: an empty value in .env.local means "use the default".
  rpcUrl: process.env.NEXT_PUBLIC_STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  explorer: "https://stellar.expert/explorer/testnet",
} as const;

export const SMART_ACCOUNT = {
  // OpenZeppelin stellar-accounts v0.8.0 account build.
  accountWasmHash: "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1",
  webauthnVerifier: "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
  // The verifier's wasm, read from testnet 2026-11-26. It runs inside every
  // passkey signature check.
  webauthnVerifierWasmHash: "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76",
  // smart-account-kit 0.10.0 shared deployer: Keypair.fromRawEd25519Seed(sha256("openzeppelin-smart-account-kit")).
  // Sign-only; it never pays fees. Seen as the deployer in wallet deploy tx 1559440b...
  sharedDeployer: "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N",
} as const;

export const SPLIT = {
  // sha256 of contracts/split wasm with the constructor's `created` event, uploaded to testnet 2026-11-28
  // (tx b6585d3a968922cd6a51e0c6b437895ba20975f3f3c364968625b844e2969578). The only split wasm the relay
  // deploys, and the only one the tax estimate reads.
  wasmHash: "ca6befd2b75c60ef2b3019667c11e26e675364aa4b0380783d8589b62d07f56c",
  // Earlier split wasm (invoice binding + withdraw-to-self guard, 2026-11-25, no `created` event). Splits already
  // deployed from it keep working through the relay, so their USDC is never stranded, but the relay no longer
  // deploys it: a split's address is fixed per wallet, so a wallet given this wasm could never get a tax estimate.
  earlierWasmHashes: ["b97d71c33aa88dbc12bacb07f4903590e2a0ad4fc4729219e8e9c94d6c2f8c58"],
} as const;

/** Every split wasm the relay sponsors calls on: the current one and the earlier ones. */
export const SPLIT_CALLABLE_WASM: readonly string[] = [SPLIT.wasmHash, ...SPLIT.earlierWasmHashes];

export const TOKENS = {
  // Circle testnet USDC: USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  xlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
} as const;

export const explorerLink = (kind: "contract" | "tx" | "account", id: string) =>
  `${NETWORK.explorer}/${kind}/${id}`;
