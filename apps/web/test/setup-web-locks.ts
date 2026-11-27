// Node has no Web Locks API (navigator.locks); browsers that support passkeys
// all do. The wallet page needs it to create a wallet, so tests get a minimal
// one, shared by every simulated tab in a test file, like a real browser's.
// Only { ifAvailable: true } is used by the app. Each test starts as a fresh
// browser: locks a test left held (an attempt that never finishes) are let go.
import { beforeEach } from "vitest";

type Callback = (lock: unknown) => Promise<unknown>;

const held = new Set<string>();
beforeEach(() => held.clear());

// Installed every time this file runs (once per test file), even over one a
// previous test file installed, so `held` above is always the one in use.
{
  const locks = {
    async request(name: string, options: { ifAvailable?: boolean } | Callback, cb?: Callback) {
      const callback = typeof options === "function" ? options : cb!;
      const ifAvailable = typeof options === "object" && options.ifAvailable === true;
      if (held.has(name)) {
        if (ifAvailable) return callback(null);
        throw new Error("test Web Locks: only { ifAvailable: true } is supported");
      }
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
  };
  const nav = globalThis.navigator as object | undefined;
  if (nav) Object.defineProperty(nav, "locks", { value: locks, configurable: true });
  else Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: true });
}
