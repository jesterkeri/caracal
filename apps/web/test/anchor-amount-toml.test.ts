import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromStroops, toStroops } from "../src/lib/anchor/amount";
import { readToml, parseTopLevel } from "../src/lib/anchor/toml";
import { AnchorError } from "../src/lib/anchor/errors";

const toml = readFileSync(new URL("./fixtures/anchor/stellar.toml", import.meta.url), "utf8");

describe("exact USDC amounts", () => {
  it("reads whole and decimal amounts into stroops", () => {
    expect(toStroops("2")).toBe(BigInt(20_000_000));
    expect(toStroops("2.5")).toBe(BigInt(25_000_000));
    expect(toStroops("0.0000001")).toBe(BigInt(1));
    expect(toStroops(" 10 ")).toBe(BigInt(100_000_000));
  });
  it("refuses anything that is not a plain positive decimal with at most 7 places", () => {
    for (const bad of ["", "-1", "1e3", "1.12345678", "abc", "1,5", "0x10", ".5", "1.", "NaN", "Infinity", "1 000"]) {
      expect(toStroops(bad), bad).toBeNull();
    }
  });
  it("prints stroops as the shortest exact decimal and round-trips", () => {
    expect(fromStroops(BigInt(20_000_000))).toBe("2");
    expect(fromStroops(BigInt(1))).toBe("0.0000001");
    for (const s of ["2", "2.5", "0.1", "123456.7654321"]) expect(fromStroops(toStroops(s)!)).toBe(s);
  });
});

describe("the anchor's stellar.toml (real answer, captured 2026-11-27)", () => {
  it("is read for the SEP-45 and SEP-24 addresses, the signing key and the pinned contract", () => {
    expect(readToml(toml)).toEqual({
      signingKey: "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR",
      webAuthEndpoint: "https://testanchor.stellar.org/sep45/auth",
      transferServer: "https://testanchor.stellar.org/sep24",
      webAuthContract: "CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX",
    });
  });
  it("ignores keys inside tables", () => {
    expect(parseTopLevel(`A = "1"\n[T]\nB = "2"`)).toEqual({ A: "1" });
  });
  it("refuses a different web auth contract, naming the cause", () => {
    const changed = toml.replace("CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(() => readToml(changed)).toThrow(/sign-in contract is not the one Caracal expects/);
  });
  it("refuses endpoints that are not https on the anchor's own domain", () => {
    for (const bad of ["http://testanchor.stellar.org/sep45/auth", "https://evil.example/sep45/auth", "https://testanchor.stellar.org.evil.example/sep45/auth", "https://u:p@testanchor.stellar.org/sep45/auth"]) {
      expect(() => readToml(toml.replace("https://testanchor.stellar.org/sep45/auth", bad)), bad).toThrow(AnchorError);
    }
    expect(() => readToml(toml.replace("https://testanchor.stellar.org/sep24", "http://testanchor.stellar.org/sep24"))).toThrow(/cash-out address/);
  });
  it("refuses a toml without a signing key", () => {
    expect(() => readToml(toml.replace(/SIGNING_KEY = ".*"/, ""))).toThrow(/signing key/);
  });
});
