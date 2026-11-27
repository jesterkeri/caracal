// src/lib/tax/engine.d.ts carries a copy of packages/tax/src/types.ts (the web
// app cannot compile the engine's source yet; see that file). This keeps the
// copy identical, so the web app is never type-checked against stale types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, estimate, getRules } from "../src/lib/tax/engine";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("engine types copy", () => {
  it("is identical to packages/tax/src/types.ts", () => {
    const d = read("../src/lib/tax/engine.d.ts");
    const start = "// ---- copy of packages/tax/src/types.ts starts on the next line ----\n";
    const end = "// ---- copy ends ----\n";
    const copy = d.slice(d.indexOf(start) + start.length, d.indexOf(end));
    expect(copy).toBe(read("../../../packages/tax/src/types.ts"));
  });

  it("declares the same functions the engine exports, and they are the engine's", () => {
    const d = read("../src/lib/tax/engine.d.ts");
    for (const name of ["estimate", "getRules", "DISCLAIMER"]) expect(d).toContain(`export ${name === "DISCLAIMER" ? "const" : "function"} ${name}`);
    expect(typeof estimate).toBe("function");
    expect(getRules("NG", 2026)?.year).toBe(2026);
    expect(DISCLAIMER).toBe("This is an estimate, not tax advice.");
  });
});
