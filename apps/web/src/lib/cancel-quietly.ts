/**
 * Starts cancelling a stream and does not wait for it: a stream whose cancellation never settles must not hold the
 * read that gave up on it (Codex tax R6). A refusal, thrown or rejected, is ignored.
 */
export function cancelQuietly(cancel: () => Promise<unknown> | undefined): void {
  try {
    void cancel()?.catch(() => {});
  } catch {
    // nothing to do: the read has already ended
  }
}
