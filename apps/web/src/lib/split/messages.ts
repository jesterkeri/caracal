// What the split page says after a write, one sentence per thing known.

import type { SendOutcome } from "./send";

export type Said = { tone: "good" | "bad" | "unsure"; text: string; hash?: string };

/** `what` is the action in past tense without a subject, like "Your withdrawal". */
export function say(outcome: SendOutcome, what: string): Said {
  switch (outcome.kind) {
    case "done":
      return { tone: "good", text: `${what} went through.`, hash: outcome.hash };
    case "refused":
      // The relay's own words: they say that nothing was sent.
      return { tone: "bad", text: outcome.message };
    case "stopped":
      return { tone: "bad", text: outcome.message };
    case "unknown":
      return {
        tone: "unsure",
        text: `Caracal could not confirm whether ${what.toLowerCase()} went through (${outcome.message.replace(/[.\s]+$/, "")}). What is shown below was just read from the network.`,
        hash: outcome.hash,
      };
  }
}
