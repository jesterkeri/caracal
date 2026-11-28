// Adversary i6. Goal 4 ("may have gone through" when nothing was sent).
//
// Promise (docs/decisions.md, 2026-11-27, adversary i2): "Every relay refusal made before anything is sent says
// 'Nothing was sent' for calls too ... without it a pay or split page could not tell a refused call from a lost
// answer and told the payer the payment 'may have gone through'." That phrase is the only thing
// lib/invoices/chain.ts sendCall reads to call a refusal "not sent" (text.includes("Nothing was sent")).
//
// relay/channels.ts submitToChannels answers a Channels HTTP 429 with "The fee sponsor is busy. Try again
// shortly." and status 429. A 429 is the service refusing the request before it processes it (the relay's own
// 429s, route.ts refuse(...), do say "Nothing was sent"), but this one does not carry the phrase. So the kit
// hands the page a message without it, sendCall classifies it "unknown", and the payer is told "Caracal could
// not confirm whether the payment went through. Do not pay again yet" (the freelancer, after "Open invoice",
// is told the opening "may have gone through" and gets no Remove for 3 minutes), although nothing was sent.
//
// The real @openzeppelin/relayer-plugin-channels client runs against the local fake Channels service
// (test/setup-relay-server.ts), as test/relay-channels.test.ts does. 429 with an empty body is the case in
// which the client raises PluginTransportError with a statusCode (channels-client.js parseAxiosError).
import { describe, expect, it } from "vitest";
import { channelsClient, submitToChannels } from "../src/lib/relay/channels";
import { sendCall } from "../src/lib/invoices/chain";
import { fakeChannels } from "./setup-relay-server";

describe("a Channels 429", () => {
  it("control: a refusal Channels names as raised before sending says 'Nothing was sent'", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "bad", data: { code: "TIMEBOUNDS_EXPIRED" } }));
    };
    const out = await submitToChannels(channelsClient("k-1", fakeChannels.url, 2000), "AAAA");
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect((out as { error: string }).error).toContain("Nothing was sent");
  });

  // Both tests below reversed by Codex Day 1 R8 #3 when Day 1 was merged into this branch (disclosed in
  // docs/decisions.md): an HTTP 429 alone does not prove the transaction was refused before it was sent, so it is
  // reported as unknown. They asserted the opposite ("Nothing was sent", status 429; outcome "not-sent") until then.
  it("is reported as unknown: a bare 429 does not prove nothing was sent", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(429);
      res.end();
    };
    const out = await submitToChannels(channelsClient("k-1", fakeChannels.url, 2000), "AAAA");
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect((out as { error: string }).error).not.toContain("Nothing was sent");
    expect((out as { error: string }).error).toContain("Check your activity");
  });

  it("so a payer whose request got a bare 429 is told it may have gone through (kit result as 0.10.0 builds it)", async () => {
    // What smart-account-kit 0.10.0 gives signAndSubmit's caller for a relay answer { success:false, error } :
    // submissionFailure(error) -> a SubmissionError (code 5003) whose message is the relay's error text.
    fakeChannels.reply = (_req, res) => {
      res.writeHead(429);
      res.end();
    };
    const out = (await submitToChannels(channelsClient("k-1", fakeChannels.url, 2000), "AAAA")) as { error: string };
    const kit = {
      rpc: {},
      signAndSubmit: async () => ({ success: false as const, error: Object.assign(new Error(out.error), { code: 5003 }) }),
    };
    const built = { simulation: undefined };
    const { contract } = await import("@stellar/stellar-sdk");
    const orig = contract.AssembledTransaction.build;
    contract.AssembledTransaction.build = (async () => built) as never;
    try {
      const outcome = await sendCall(kit as never, "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX", "deposit", []);
      expect(outcome.kind).toBe("unknown");
    } finally {
      contract.AssembledTransaction.build = orig;
    }
  });
});
