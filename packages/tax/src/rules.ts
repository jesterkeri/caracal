import ng2026 from "../rules/NG/2026.json" with { type: "json" };
import type { Rules } from "./types";

// Adding a year means adding a JSON file and one line here.
const registry: Record<string, Rules> = {
  "NG:2026": ng2026 as unknown as Rules,
};

/** Returns the rules for a country and year, or null when none exist. */
export function getRules(country: string, year: number): Rules | null {
  return registry[`${country}:${year}`] ?? null;
}
