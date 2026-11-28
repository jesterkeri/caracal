// Adversary s19 follow-up: a write that went through carries the ledger the kit says it was included in, so the page
// shows only pots read at or after it (src/app/split/page.tsx run()). Without a usable ledger the page falls back to
// the write's closeBy, which adversary-s19-done-write-lagging-read.test.ts covers.
import { describe, expect, it } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { sendSplitCall, type BuildTx, type WriteKit } from "../src/lib/split/send";
import { WALLET } from "./relay-fixtures";
import { SPLIT } from "./s4-fake-network";

const build: BuildTx = async () => ({}) as never;
const kitAnswering = (result: unknown): WriteKit => ({ rpc: {}, rpcUrl: "https://rpc.invalid", networkPassphrase: "Test SDF Network ; September 2015", signAndSubmit: async () => result as never });
const send = (result: unknown) => sendSplitCall(kitAnswering(result), withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT, build);

describe("a done write's ledger", () => {
  it("is passed on when the kit gives one", async () => {
    expect(await send({ success: true, hash: "ab".repeat(32), ledger: 1234 })).toEqual({ kind: "done", hash: "ab".repeat(32), ledger: 1234 });
  });

  it("is left out when the kit gives none or one that is not a ledger", async () => {
    for (const ledger of [undefined, 0, -1, 1.5, 2 ** 32, "1234"]) {
      expect(await send({ success: true, hash: "cd".repeat(32), ledger })).toEqual({ kind: "done", hash: "cd".repeat(32) });
    }
  });
});
