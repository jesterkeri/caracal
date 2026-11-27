// Adversary c6: the page blames the wallet's balance for ANY failure of its own simulation of the
// USDC payment, while it shows the person that the balance is enough.
//
// Spec: goal 4 (a person is told something false: a wrong cause) and docs/decisions.md 2026-11-27
// (Cash-out: RPC calls ... "a failure is named as the network's"; the c2/c4 rows: "failures name their
// true cause"). Cause: src/lib/anchor/transfer.ts buildAnchorTransfer(), the `isSimulationError`
// branch, always says "Your wallet may not hold enough USDC", whatever the network answered (the
// recipient's missing trustline or account, a deauthorised balance, a contract fault ...). The page
// has just read the balance itself (src/app/cashout/page.tsx, "USDC in the wallet: 9 USDC"), so for a
// 2 USDC cash-out the line is plainly the wrong cause, and the person is sent to check a balance
// that is fine while the real problem is never named.
//
// Real: the page, src/lib/anchor/*, stellar-sdk's rpc.Server and AssembledTransaction, against a
// 127.0.0.1 server that answers simulateTransaction with the shape the RPC uses for a failed
// simulation (`error` text plus `latestLedger`). The diagnostic text is the one recorded live on
// 2026-11-27 (docs/research/anchor-spike-2026-11-27.md section 5). Faked: anchor, kit, popup.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rpc } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

const realSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
let server: http.Server;
let url: string;
let simulations = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body) as { id: number; method: string };
      if (j.method === "simulateTransaction") simulations++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { latestLedger: 123, error: "HostError: Error(Contract, #10)" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  simulations = 0;
  vi.restoreAllMocks(); // test/setup-relay-server.ts stubs rpc.Server.simulateTransaction; this test needs the real SDK
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); // sockets run in real time
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** Presses Send and lets the real socket and the page's own clock run until the page leaves "Waiting for your passkey...". */
async function sendAndSettle(rt: Parameters<typeof text>[0], press: () => unknown) {
  void press();
  for (let i = 0; i < 40; i++) {
    await realSleep(100);
    await tick(50);
    if (!text(rt).includes("Waiting for your passkey")) return;
  }
}

describe("adversary c6: the cause named when the network rejects the payment in simulation", () => {
  it("control: the page shows a balance of 9 USDC for a 2 USDC cash-out, and the simulation really failed and sent nothing", async () => {
    const real = new rpc.Server(url, { allowHttp: true });
    const kitRpc = Object.assign(Object.create(real) as rpc.Server, { getLatestLedger: async () => ({ sequence: 100 }) });
    const { rt, world } = await mount({ rpc: kitRpc, realBuild: true });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("USDC in the wallet: 9 USDC");
    await sendAndSettle(rt, () => clickButton(rt.tree, /Send 2 USDC/));
    expect(simulations).toBeGreaterThan(0);
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    expect(text(rt)).toContain("The network rejected the USDC payment before it was signed, so nothing was sent.");
    rt.unmount();
  });

  it("a rejected simulation with a sufficient balance on screen must not tell the person their wallet may not hold enough USDC", async () => {
    const real = new rpc.Server(url, { allowHttp: true });
    const kitRpc = Object.assign(Object.create(real) as rpc.Server, { getLatestLedger: async () => ({ sequence: 100 }) });
    const { rt, world } = await mount({ rpc: kitRpc, realBuild: true });
    await toConfirm(rt, world);
    expect(text(rt)).toContain("USDC in the wallet: 9 USDC"); // the balance the page itself read: enough for 2 USDC
    await sendAndSettle(rt, () => clickButton(rt.tree, /Send 2 USDC/));
    expect(text(rt)).toContain("The network rejected the USDC payment before it was signed"); // the harness reached the failure
    expect(text(rt)).not.toMatch(/may not hold enough USDC/);
    rt.unmount();
  });
});
