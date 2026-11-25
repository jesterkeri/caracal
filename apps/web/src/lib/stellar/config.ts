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
  // smart-account-kit 0.10.0 shared deployer: Keypair.fromRawEd25519Seed(sha256("openzeppelin-smart-account-kit")).
  // Sign-only; it never pays fees. Seen as the deployer in wallet deploy tx 1559440b...
  sharedDeployer: "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N",
} as const;

export const SPLIT = {
  // sha256 of contracts/split wasm with invoice binding (fix/invoice-binding,
  // deployed 2026-11-25 as CAD5AH4U3ONNMZJKYC2BECMOMFACKG4JGNYLZIEERSIYWX2NAC26DVVB).
  wasmHash: "70fb8ddce2908fc095439eb57f099fe559d8ffee85fe76750d48ec93059a990d",
} as const;

export const TOKENS = {
  // Circle testnet USDC: USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  xlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
} as const;

export const explorerLink = (kind: "contract" | "tx" | "account", id: string) =>
  `${NETWORK.explorer}/${kind}/${id}`;
