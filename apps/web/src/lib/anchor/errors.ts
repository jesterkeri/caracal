/** A cash-out failure named for what failed, in plain English. `message` is safe to show. */
export class AnchorError extends Error {
  constructor(
    message: string,
    /** Where it went wrong, so the page can decide what to offer next. */
    readonly step: "anchor-info" | "sign-in" | "start" | "form" | "send" | "status",
    /** True when the anchor or the chain may have acted anyway, so the outcome is not known. */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "AnchorError";
  }
}

/** The text of any thrown value, without ever including a token. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
