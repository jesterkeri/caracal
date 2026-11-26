// Adversary r4c: a Supabase answer of HTTP 500 is not "could not reach".
// decisions.md 2026-11-26 (adversary r4b): "A failed sign-in code exchange names
// only causes the error shows: ... Supabase not answering or the request
// deadline ('unreachable', new message), anything else the generic message."
// The "unreachable" message says Caracal "could not reach the sign-in service
// ... Check your connection". A 500 is Supabase answering with a server error,
// so the cause (the person's connection) is one the error does not show.
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SIGNIN_ERRORS, exchangeErrorCode } from "../src/lib/auth/signin-errors";

describe("adversary r4c: exchangeErrorCode", () => {
  it("control: the 10 s deadline (auth-js AuthRetryableFetchError, status 0) is 'unreachable'", () => {
    expect(exchangeErrorCode(new AuthRetryableFetchError("Supabase did not answer in time", 0))).toBe("unreachable");
  });

  it("a Supabase 500 that came back as an answer is not reported as 'could not reach ... check your connection'", () => {
    const answered = new AuthApiError("Database error saving new user", 500, "unexpected_failure");
    const code = exchangeErrorCode(answered);
    expect(code, `got "${SIGNIN_ERRORS[code]}"`).not.toBe("unreachable");
  });
});
