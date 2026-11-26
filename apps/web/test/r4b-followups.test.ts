// Follow-up to adversary r4b's suspicion: the sign-in callback mapped every
// failed code exchange to "expired", naming a cause it could not know.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNIN_ERRORS, exchangeErrorCode } from "../src/lib/auth/signin-errors";

afterEach(() => {
  vi.doUnmock("@/lib/supabase/server");
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("r4b follow-up: what a failed code exchange tells the person", () => {
  it.each([
    [{ name: "AuthApiError", code: "flow_state_not_found", status: 404 }, "expired"],
    [{ name: "AuthApiError", code: "bad_code_verifier", status: 400 }, "expired"],
    [{ name: "AuthPKCECodeVerifierMissingError", code: "pkce_code_verifier_not_found", status: 400 }, "expired"],
    [{ name: "AuthRetryableFetchError", status: 0 }, "unreachable"],
    [{ name: "AuthRetryableFetchError", status: 503 }, "unreachable"],
    [{ name: "AuthApiError", code: "invalid_credentials", status: 401 }, "failed"], // a wrong anon key: no false cause
  ])("%o gives %s", (error, code) => expect(exchangeErrorCode(error)).toBe(code));

  async function callback(exchange: () => Promise<unknown>) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    vi.doMock("@/lib/supabase/server", () => ({ supabaseServer: async () => ({ auth: { exchangeCodeForSession: exchange } }) }));
    const { GET } = await import("../src/app/auth/callback/route");
    const r = await GET(new Request("https://caracal.test/auth/callback?code=abc"));
    return new URL(r.headers.get("location")!).searchParams.get("error");
  }
  it("Supabase not answering is named as such, not as an expired sign-in", async () => {
    expect(await callback(async () => ({ error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } }))).toBe("unreachable");
    expect(SIGNIN_ERRORS.unreachable).toMatch(/could not reach/);
  });
  it("an exchange that throws (the request deadline) redirects with a message instead of a 500", async () => {
    expect(await callback(async () => {
      throw new DOMException("Supabase did not answer in time", "TimeoutError");
    })).toBe("unreachable");
  });
  it("a genuinely expired sign-in attempt still says so", async () => {
    expect(await callback(async () => ({ error: { name: "AuthApiError", code: "flow_state_expired", status: 400, message: "expired" } }))).toBe("expired");
  });
});
