// The relay half of adversary i6 #2 (kept on feat/invoices-pay as adversary-i6-channels-429-not-flagged-unsent.test.ts,
// which also runs the invoices page code). Copied unchanged from its first two tests; the third needs the invoices code.
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

  it("is not reported as something that may have been sent", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(429);
      res.end();
    };
    const out = await submitToChannels(channelsClient("k-1", fakeChannels.url, 2000), "AAAA");
    expect(out).toMatchObject({ ok: false, status: 429 });
    // Fails today: "The fee sponsor is busy. Try again shortly." has no "Nothing was sent", so every page treats it as a lost answer.
    expect((out as { error: string }).error).toContain("Nothing was sent");
  });
});
