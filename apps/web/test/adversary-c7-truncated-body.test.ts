// Adversary c7: an anchor answer cut off partway is reported as something the anchor said.
//
// Spec: goal 4 (a wrong cause) and docs/decisions.md 2026-11-27 ("a failure is named as the network's"):
// a connection that drops while the anchor's answer is being read is a network failure, not the anchor
// saying it does not list a sign-in address or does not offer USDC withdrawals.
// Cause: requestWithin() (src/lib/anchor/errors.ts, `await res.text().catch(() => "")`) turns a failed
// body read into an empty body with ok: true, so loadToml() / loadInfo() go on to parse "" and blame
// the anchor ("does not list a sign-in address", "does not offer USDC withdrawals right now").
//
// Real: loadToml, loadInfo (src/lib/anchor), the Fetch API's Response and ReadableStream. Faked: only
// the fetch function, which answers 200 and then breaks the stream partway through the body.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnchorError } from "../src/lib/anchor/errors";
import { loadInfo } from "../src/lib/anchor/sep24";
import { loadToml } from "../src/lib/anchor/toml";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/anchor/${n}`, import.meta.url), "utf8");

/** 200 with the first half of `body`, then the connection breaks. */
const cutOff = (body: string): typeof fetch =>
  (async () => {
    const bytes = new TextEncoder().encode(body.slice(0, Math.floor(body.length / 2)));
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(bytes);
        } else c.error(new TypeError("network error"));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

const whole = (body: string): typeof fetch => (async () => new Response(body, { status: 200 })) as typeof fetch;
const refused: typeof fetch = (async () => {
  throw new TypeError("Failed to fetch");
}) as typeof fetch;

const messageOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AnchorError);
    return (e as AnchorError).message;
  }
  throw new Error("expected the load to fail");
};

describe("adversary c7: an answer that breaks off while it is read", () => {
  it("control: a whole answer loads, and a refused connection is named as the connection", async () => {
    expect((await loadInfo("https://testanchor.stellar.org/sep24", whole(fixture("sep24-info.json")))).enabled).toBe(true);
    expect((await loadToml(whole(fixture("stellar.toml")))).transferServer).toMatch(/testanchor\.stellar\.org/);
    expect(await messageOf(loadInfo("https://testanchor.stellar.org/sep24", refused))).toMatch(/could not reach the test anchor/);
  });

  it("the cash-out limits cut off mid-answer are a connection failure, not 'USDC withdrawals are not offered'", async () => {
    const msg = await messageOf(loadInfo("https://testanchor.stellar.org/sep24", cutOff(fixture("sep24-info.json"))));
    expect(msg).not.toMatch(/does not offer USDC withdrawals/);
    expect(msg).toMatch(/could not reach|connection|network/i);
  });

  it("the anchor's details cut off mid-answer are a connection failure, not 'no sign-in address listed'", async () => {
    const msg = await messageOf(loadToml(cutOff(fixture("stellar.toml"))));
    expect(msg).not.toMatch(/does not list/);
    expect(msg).toMatch(/could not reach|connection|network/i);
  });
});
