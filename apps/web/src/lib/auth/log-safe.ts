// Text from a URL, made safe to write to a log line.

/** At most 80 characters of letters, digits, `_`, `-` and `.`; anything else becomes `?`. */
export function logSafe(value: string | null): string {
  if (value === null) return "(none)";
  return value.slice(0, 80).replace(/[^A-Za-z0-9_.-]/g, "?");
}
