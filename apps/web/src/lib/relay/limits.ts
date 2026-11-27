// Time limits of the fee relay that the wallet page relies on.

/**
 * Longest time from a request's arrival at /api/relay to sending it upstream
 * (the policy's lookups, the wait in the queue, and building it). A request
 * not sent by then is refused ("Nothing was sent"), never sent later.
 */
export const SEND_DEADLINE_MS = 60_000;
