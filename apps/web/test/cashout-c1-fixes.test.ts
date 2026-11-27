// Adversary c1 fixes: what counts as "not sent", and the 20 second deadline on anchor requests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { startWithdraw } from "../src/lib/anchor/sep24";
import { loadToml } from "../src/lib/anchor/toml";
import type { AnchorTxn } from "../src/lib/anchor/sep24";

const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
const waiting: AnchorTxn = {
  id: "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef",
  status: "pending_user_transfer_start",
  message: null,
  amountIn: "2",
  amountOut: null,
  feeTotal: null,
  withdrawAnchorAccount: "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR",
  withdrawMemo: "123",
  withdrawMemoType: "id",
  stellarTransactionId: null,
};
const TWO = BigInt(20_000_000);

const failing = (error: { code?: number; message: string }, hash?: string): SendDeps => ({
  buildTransfer: async () => ({}),
  signAndSubmit: async () => ({ success: false, hash, error }),
});

describe("what counts as not sent", () => {
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("a relay that did not answer (5003, no hash) is unknown", async () => {
    const r = await sendToAnchor(waiting, TWO, failing({ code: 5003, message: "The fee relayer did not answer. Check your activity before trying again." }));
    expect(r).toMatchObject({ kind: "unknown", message: expect.stringMatching(/Do not send it again/) });
  });
  it("an unknown code with no proof is unknown", async () => {
    expect(await sendToAnchor(waiting, TWO, failing({ message: "odd" }))).toMatchObject({ kind: "unknown" });
  });
  it("a signing step failure before anything was submitted is not sent", async () => {
    expect(await sendToAnchor(waiting, TWO, failing({ code: 5002, message: "signing failed" }))).toMatchObject({ kind: "not-sent" });
    expect(await sendToAnchor(waiting, TWO, failing({ code: 5001, message: "simulation failed" }))).toMatchObject({ kind: "not-sent" });
  });
  it("a hash makes it unknown even with a signing code", async () => {
    expect(await sendToAnchor(waiting, TWO, failing({ code: 5002, message: "x" }, "ab"))).toMatchObject({ kind: "unknown" });
  });
});

describe("anchor request deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  it("a withdraw start that never answers ends in an error saying the anchor may have started it", async () => {
    const p = startWithdraw("https://testanchor.stellar.org/sep24", "tok", WALLET, TWO, never).then(() => null, (e: unknown) => e as Error & { outcomeUnknown: boolean });
    await vi.advanceTimersByTimeAsync(20_001);
    const e = (await p)!;
    expect(e.message).toMatch(/may have started it/);
    expect(e.outcomeUnknown).toBe(true);
  });
  it("the anchor's details read ends in a shown error", async () => {
    const p = loadToml(never).then(() => new Error("no error"), (e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await p).message).toMatch(/did not answer within 20 seconds/);
  });
});
