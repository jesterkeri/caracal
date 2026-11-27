// Adversary c2: the cash-out page waits on the Stellar RPC with no deadline.
//
// decisions.md (2026-11-27, Cash-out fixes (3)) bounds every request to the ANCHOR at 20 s, and
// src/lib/relay/sponsor.ts says "The SDK has no timeout by default" (RPC_TIMEOUT_MS). The page
// itself reads the RPC in two places on the way to a payment, with no deadline at all:
//   - sign-in:  latestLedger() = kit.rpc.getLatestLedger() (src/app/cashout/page.tsx start())
//   - send:     buildAnchorTransfer() simulates the transfer on kit.rpc (page.tsx send())
// An RPC that accepts the connection and never answers leaves the page on "Signing in..." or on
// "Waiting for your passkey..." for ever, with no control to press (goal 5).
//
// Real, not faked: stellar-sdk's rpc.Server and AssembledTransaction against a 127.0.0.1 server
// that accepts and never answers. Faked: the anchor (the repo's captured fixtures), the kit, the popup.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rpc } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, mount, pressContinue, text, tick, toConfirm, unmock, clickButton } from "./adversary-c2-harness";

const realSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
let server: http.Server;
let url: string;
let connections = 0;
beforeAll(async () => {
  server = http.createServer(() => {
    connections++; // accepts the request, never answers
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  connections = 0;
  vi.restoreAllMocks(); // test/setup-relay-server.ts stubs rpc.Server.simulateTransaction for every test; this one needs the real SDK
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); // sockets run in real time
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

describe("adversary c2: an RPC that never answers", () => {
  it("control: with an answering RPC the page signs in and reaches the anchor's form", async () => {
    const { rt } = await mount();
    await pressContinue(rt);
    await tick(50);
    expect(text(rt)).toContain("Finish the anchor's form");
    rt.unmount();
  });

  it("control: the real stellar-sdk rpc.Server pointed at this server really does hang (the SDK has no timeout)", async () => {
    const s = new rpc.Server(url, { allowHttp: true });
    vi.useRealTimers();
    const outcome = await Promise.race([s.getLatestLedger().then(() => "answered", () => "rejected"), new Promise<string>((r) => setTimeout(() => r("hangs"), 1500))]);
    expect(outcome).toBe("hangs");
    expect(connections).toBeGreaterThan(0);
  });

  it("sign-in: a latest-ledger read that never answers does not leave the page on 'Signing in...' for ever", async () => {
    const hanging = new rpc.Server(url, { allowHttp: true });
    const { rt } = await mount({ rpc: hanging });
    await pressContinue(rt);
    await realSleep(400); // real time: the request reaches the server
    await tick(10 * 60_000); // then ten minutes of the page's own time
    expect(connections).toBeGreaterThan(0); // the page really is waiting on the RPC
    expect(text(rt)).not.toContain("Signing in to the anchor with your passkey");
    rt.unmount();
  });

  it("send: a transfer simulation that never answers does not leave the page on 'Waiting for your passkey...' for ever", async () => {
    const hanging = new rpc.Server(url, { allowHttp: true });
    // getLatestLedger answers (sign-in works); the simulation of the transfer is what hangs.
    const kitRpc = Object.assign(Object.create(hanging) as rpc.Server, { getLatestLedger: async () => ({ sequence: 100 }) });
    const { rt, world } = await mount({ rpc: kitRpc, realBuild: true });
    await toConfirm(rt, world);
    expect(buttonLabels(rt.tree)).toContain("Send 2 USDC to the anchor");
    void clickButton(rt.tree, /Send 2 USDC/);
    await realSleep(400);
    await tick(10 * 60_000);
    expect(connections).toBeGreaterThan(0); // the simulation request reached the RPC and got no answer
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled(); // no passkey prompt was ever asked for
    expect(buttonLabels(rt.tree)).not.toContain("Waiting for your passkey...");
    rt.unmount();
  });
});
