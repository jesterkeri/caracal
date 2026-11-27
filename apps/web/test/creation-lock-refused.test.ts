// withCreationLock: a browser that refuses the lock request runs nothing and
// says "refused"; an error from the work itself, once it holds the lock, is
// passed on unchanged (it is not mistaken for a refusal).
import { describe, expect, it, vi } from "vitest";
import { withCreationLock, type Locks } from "../src/lib/auth/creation-lock";

describe("withCreationLock when the request fails", () => {
  it("a refused request runs nothing and reports 'refused'", async () => {
    const locks: Locks = {
      request: async () => {
        throw new DOMException("Access to the Locks API is denied in this context.", "SecurityError");
      },
    };
    const fn = vi.fn(async () => 1);
    await expect(withCreationLock(locks, fn)).resolves.toEqual({ ran: false, why: "refused" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("an error thrown by the work under the lock is passed on", async () => {
    const locks: Locks = { request: (_n, _o, cb) => cb({}) };
    await expect(withCreationLock(locks, async () => Promise.reject(new Error("kit failed")))).rejects.toThrow("kit failed");
  });
});
