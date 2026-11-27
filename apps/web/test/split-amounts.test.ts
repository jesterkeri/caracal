import { describe, expect, it } from "vitest";
import { bpsText, formatUsdc, parsePercent, parseUsdc, splitProblem } from "../src/lib/split/amounts";

describe("USDC amounts typed by a person", () => {
  it("reads whole and decimal amounts exactly, in stroops (7 decimals)", () => {
    expect(parseUsdc("25")).toEqual({ ok: true, value: BigInt(250_000_000) });
    expect(parseUsdc("12.5")).toEqual({ ok: true, value: BigInt(125_000_000) });
    expect(parseUsdc(" 0.0000001 ")).toEqual({ ok: true, value: BigInt(1) });
    expect(parseUsdc("7.")).toEqual({ ok: true, value: BigInt(70_000_000) });
  });
  it("never rounds: more than 7 decimals is refused", () => {
    const r = parseUsdc("1.00000001");
    expect(r.ok).toBe(false);
  });
  it.each(["", "  ", "0", "0.0", "-5", "+5", "1e3", "1,5", "abc", "0x10", "1 000", ".5", "NaN", "Infinity", "1234567890123"])("refuses %j", (text) => {
    expect(parseUsdc(text).ok).toBe(false);
  });
  it("formats with 2 to 7 decimals and round-trips", () => {
    expect(formatUsdc(BigInt(125_000_000))).toBe("12.50");
    expect(formatUsdc(BigInt(0))).toBe("0.00");
    expect(formatUsdc(BigInt(1))).toBe("0.0000001");
    expect(formatUsdc(BigInt(75_000))).toBe("0.0075");
    for (const t of ["12.50", "0.0075", "999999999999.1234567"]) {
      const p = parseUsdc(t);
      expect(p.ok && formatUsdc(p.value)).toBe(t);
    }
  });
});

describe("split percentages", () => {
  it("become whole basis points", () => {
    expect(parsePercent("10", "tax")).toEqual({ ok: true, value: 1000 });
    expect(parsePercent("12.5", "tax")).toEqual({ ok: true, value: 1250 });
    expect(parsePercent("0.05", "tax")).toEqual({ ok: true, value: 5 });
    expect(parsePercent("100", "goal")).toEqual({ ok: true, value: 10_000 });
    expect(parsePercent("0", "goal")).toEqual({ ok: true, value: 0 });
  });
  it.each(["", "-1", "100.01", "101", "1.234", "ten", "1e2", "1,5"])("refuses %j", (text) => {
    expect(parsePercent(text, "tax").ok).toBe(false);
  });
  it("names which percentage is wrong", () => {
    const r = parsePercent("", "goal");
    expect(!r.ok && r.message).toMatch(/goal/);
  });
  it("tax plus goal may be at most 100% (the contract's BpsTooHigh bound)", () => {
    expect(splitProblem(10_000, 0)).toBeNull();
    expect(splitProblem(6000, 4000)).toBeNull();
    expect(splitProblem(6000, 4001)).toMatch(/100%/);
    expect(splitProblem(-1, 5)).not.toBeNull();
  });
  it("shows basis points as percentages", () => {
    expect(bpsText(1000)).toBe("10");
    expect(bpsText(1250)).toBe("12.5");
    expect(bpsText(5)).toBe("0.05");
    expect(bpsText(0)).toBe("0");
  });
});
