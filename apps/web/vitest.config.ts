import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same "@/" alias as tsconfig, so tests can import route handlers directly.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { setupFiles: ["./test/setup-relay-server.ts"] },
});
