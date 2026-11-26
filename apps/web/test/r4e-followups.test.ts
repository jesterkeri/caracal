// Follow-up to adversary r4e's suspicion: after "Caracal could not confirm
// whether your wallet was created. Before creating another, reload the page and
// check with Connect", the page must not offer Create right under it.
import { afterEach, describe, expect, it, vi } from "vitest";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

async function renderWallet(states: unknown[]) {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return { ...actual, default: actual, useState: (init: unknown) => [i < states.length ? states[i++] : (i++, init), () => {}], useEffect: () => {} };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: {} }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve({}) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" } });
  const mod = await import("../src/app/wallet/page");
  return texts(mod.default()).join(" | ");
}
const A = { id: "A", email: "a@x.ng" };

describe("r4e follow-up: no Create under 'could not confirm whether your wallet was created'", () => {
  it("control: another error still offers Create", async () => {
    expect(await renderWallet([{ kind: "error", message: "The passkey prompt was closed." }, "", A])).toMatch(/Create wallet with a passkey/);
  });
  it("the may-have-been-created error offers Connect, not Create", async () => {
    const shown = await renderWallet([{ kind: "error", message: "Caracal could not confirm whether your wallet was created. Before creating another, reload the page and check with Connect, using your passkey." }, "", A]);
    expect(shown).toMatch(/could not confirm whether your wallet was created/);
    expect(shown).toMatch(/I already have a wallet/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
});
