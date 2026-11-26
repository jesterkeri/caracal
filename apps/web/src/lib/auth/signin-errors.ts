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
} as const;

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
