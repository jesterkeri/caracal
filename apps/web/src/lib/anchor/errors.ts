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

/** How long any one request to the anchor may take, from sending it to reading its whole answer. */
export const ANCHOR_REQUEST_MS = 20_000;

/** A request to the anchor did not finish in time. */
export class RequestTimeout extends Error {
  constructor() {
    super("request timed out");
    this.name = "RequestTimeout";
  }
}

export type Reply = { ok: boolean; status: number; text: string };

/**
 * Send a request and read the whole answer within a deadline. A fetch that
 * ignores its abort signal is still cut off, so nothing waits for ever.
 * Throws RequestTimeout on the deadline; any other failure is passed on.
 */
export async function requestWithin(fetchFn: typeof fetch, input: string, init: RequestInit = {}, ms: number = ANCHOR_REQUEST_MS): Promise<Reply> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new RequestTimeout());
    }, ms);
  });
  const run = (async (): Promise<Reply> => {
    const res = await fetchFn(input, { ...init, signal: ctl.signal });
    // A body that breaks off partway fails the request (the network's failure), never an empty answer the
    // anchor did not give.
    return { ok: res.ok, status: res.status, text: await res.text() };
  })();
  run.catch(() => {}); // when the deadline wins, a later failure of the request is not an unhandled rejection
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `p`, or RequestTimeout once `ms` has passed. For the Stellar RPC calls on the
 * cash-out path: stellar-sdk has no timeout of its own, and a browser fetch can
 * wait for ever.
 */
export async function within<T>(p: Promise<T>, ms: number = ANCHOR_REQUEST_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeout()), ms);
  });
  p.catch(() => {}); // when the deadline wins, a later failure is not an unhandled rejection
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The JSON in an answer's text, or null when it is not JSON. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
