// Sign-in errors reach /signin as a short code, never as free text, so a link
// cannot make attacker-chosen wording appear as a Caracal message. Only the
// messages below are ever shown.

export const SIGNIN_ERRORS = {
  not_started: "Sign-in was not started from Caracal. Use the Continue with Google button.",
  cancelled: "Google sign-in was cancelled. Try again when you are ready.",
  expired:
    "Sign-in did not finish. This happens if it was opened in another browser or tab, or took too long. Try again.",
  config: "Sign-in is not set up on this server yet. The site owner needs to add the Supabase settings.",
  failed: "Sign-in did not finish. Try again.",
  unreachable: "Caracal could not reach the sign-in service to finish signing you in. Check your connection and try again.",
} as const;

/** Codes Supabase gives a code exchange that could not finish with this browser's sign-in attempt. */
const EXCHANGE_EXPIRED = new Set(["flow_state_expired", "flow_state_not_found", "bad_code_verifier", "bad_oauth_state", "bad_oauth_callback", "pkce_code_verifier_not_found"]);

/**
 * The message code for a failed code exchange. Only causes the error shows are
 * named: an expired or foreign sign-in attempt, or Supabase not answering
 * (auth-js reports that as AuthRetryableFetchError: no answer, the request
 * deadline, or a gateway status). An answer Supabase did give, such as a 500,
 * is not "could not reach": it gets the generic message.
 */
export function exchangeErrorCode(error: { code?: string; name?: string; status?: number }): SigninErrorCode {
  if (error.code && EXCHANGE_EXPIRED.has(error.code)) return "expired";
  if (error.name === "AuthRetryableFetchError" || error.status === 0) return "unreachable";
  return "failed";
}

/**
 * The message code for a code exchange that threw instead of returning an
 * error: "unreachable" only for a network failure or the request deadline,
 * anything else (a setup or program error) gets the generic message.
 */
export function thrownExchangeErrorCode(e: unknown): SigninErrorCode {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError" || name === "AuthRetryableFetchError") return "unreachable";
  if (e instanceof TypeError && /fetch failed|Failed to fetch|NetworkError|Load failed/i.test(e.message)) return "unreachable";
  return "failed";
}

export type SigninErrorCode = keyof typeof SIGNIN_ERRORS;

/** The message for a code from the URL. Unknown codes get the generic message. */
export function signinErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return Object.hasOwn(SIGNIN_ERRORS, code) ? SIGNIN_ERRORS[code as SigninErrorCode] : SIGNIN_ERRORS.failed;
}

/**
 * Maps the error Supabase or Google sends back (OAuth `error`, Supabase
 * `error_code`) to one of our codes. Returns null when there is no error.
 */
export function upstreamErrorCode(params: URLSearchParams): SigninErrorCode | null {
  const error = params.get("error");
  const errorCode = params.get("error_code");
  const description = params.get("error_description");
  if (!error && !errorCode && !description) return null;
  if (error === "access_denied") return "cancelled";
  if (errorCode === "bad_oauth_state" || errorCode === "bad_oauth_callback" || errorCode === "flow_state_expired") {
    return "expired";
  }
  return "failed";
}

/** Same-origin /signin URL carrying an error code. */
export function signinUrl(origin: string, code: SigninErrorCode | null): URL {
  const to = new URL("/signin", origin);
  if (code) to.searchParams.set("error", code);
  return to;
}
