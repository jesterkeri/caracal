import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // The kept adversary test assigns `let rt!` once, after the mocks that read it are set up.
  { files: ["test/adversary-c1-page.test.ts"], rules: { "prefer-const": "off" } },
]);

export default eslintConfig;
