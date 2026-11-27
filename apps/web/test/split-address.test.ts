import { Networks, hash } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { contractAddressFrom, splitAddressFor, SPLIT_SALT } from "../src/lib/stellar/split-address";
import { SHARED_DEPLOYER, walletAddressFor } from "../src/lib/stellar/wallet-lookup";

describe("split contract address", () => {
  it("is the same derivation the kit uses for wallets (checked against walletAddressFor)", () => {
    const cred = "AQIDBAUGBwgJCgsMDQ4PEA";
    expect(contractAddressFrom(SHARED_DEPLOYER, hash(Buffer.from(cred, "base64url")), Networks.TESTNET)).toBe(walletAddressFor(cred, Networks.TESTNET));
  });
  it("is fixed per wallet and differs between wallets", () => {
    const a = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
    const b = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
    expect(splitAddressFor(a)).toBe(splitAddressFor(a));
    expect(splitAddressFor(a)).not.toBe(splitAddressFor(b));
    expect(splitAddressFor(a)).toMatch(/^C[A-Z2-7]{55}$/);
    expect(SPLIT_SALT.toString("hex")).toHaveLength(64);
  });
  it("refuses a classic account", () => {
    expect(() => splitAddressFor("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toThrow(/passkey wallet/);
  });
});
