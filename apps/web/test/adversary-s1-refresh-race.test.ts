// Adversary s1: the page's Refresh (and Try again, Check again) re-read the
// chain without taking the page's "busy" slot, and nothing orders one re-read
// against another. So a slow Refresh that was started before a write lands
// AFTER the write's own re-read and puts the pre-write pots back on screen,
// next to "Your withdrawal went through." It also wipes the "Waiting for your
// passkey" note (setNote({ said: undefined })) while the write is still
// running, so the buttons are enabled again for a second write.
// Spec: README "Safe to spend ... " is built on the pots; the page promises
// "What is shown below was just read from the network" (messages.ts) and
// attacker goal 4: a pot balance shown must be the chain's, not an older read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

type El = { props?: { children?: unknown; onClick?: () => unknown; disabled?: boolean } };
function button(node: unknown, text: string): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = button(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  if (typeof (node as El).props?.onClick === "function" && own.includes(text)) return node as El;
  return button(kids, text);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/split/actions");
  vi.resetModules();
});

const SPLIT = splitAddressFor(WALLET);
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const BEFORE = { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) };
const AFTER = { tax: BigInt(5_000), goal: BigInt(15_000), spend: BigInt(75_000) }; // 5,000 withdrawn from Tax
const ME = { id: "A", email: "a@x.ng" };
const FORM = { deployTax: "", deployGoal: "", wdPot: "Tax", wdAmount: "0.0005", moveFrom: "Spend", moveTo: "Goal", moveAmount: "", newTax: "", newGoal: "" };
const settle = () => new Promise((r) => setTimeout(r, 20));
const present = (pots: typeof BEFORE) => ({ kind: "present", split: SPLIT, pots, config: CONFIG });

type Setter = { i: number; v: unknown };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// SplitPage state order: view, form, note, account
async function render(actions: Record<string, unknown>) {
  const setters: Setter[] = [];
  const states: unknown[] = [{ kind: "ready", wallet: WALLET, loaded: present(BEFORE) }, FORM, {}, ME];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: () => undefined,
    };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: {} }) }));
  // rpc names its latest ledger: a write reads it first to fix its last ledger (Codex split R3 fixture)
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }) };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), ...actions }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  // Fixture change (Codex split R1): storage that keeps what is written, as the write guard reads its record back.
  const kept = new Map<string, string>();
  const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  vi.stubGlobal("window", { location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" }, localStorage: store });
  const mod = await import("../src/app/split/page");
  return { tree: mod.default(), setters };
}
const lastView = (setters: Setter[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { loaded: { pots: typeof BEFORE } };
const lastNote = (setters: Setter[]) => setters.filter((s) => s.i === 2).at(-1)?.v as { busy?: string; said?: { text: string } };

describe("adversary s1: a Refresh that is still reading when a write finishes", () => {
  it("control: with no Refresh in flight, the page ends on the pots the chain holds after the withdrawal", async () => {
    const withdrawToWallet = vi.fn(async () => ({ kind: "done", hash: "ab".repeat(32) }));
    const loadSplit = vi.fn(async () => present(AFTER));
    const p = await render({ withdrawToWallet, loadSplit });
    await button(p.tree, "Withdraw with my passkey")!.props!.onClick!();
    expect(lastView(p.setters).loaded.pots).toEqual(AFTER);
    expect(lastNote(p.setters).said?.text).toMatch(/withdrawal went through/);
  });

  it("an older, slower read does not put the pre-withdrawal pots back on screen", async () => {
    const slow = deferred<unknown>();
    const withdrawToWallet = vi.fn(async () => ({ kind: "done", hash: "ab".repeat(32) }));
    // 1st read (Refresh) is slow and was taken before the withdrawal landed; 2nd (the write's re-read) sees the new pots.
    const loadSplit = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce(present(AFTER));
    const p = await render({ withdrawToWallet, loadSplit });

    void button(p.tree, "Refresh")!.props!.onClick!();
    await settle();
    await button(p.tree, "Withdraw with my passkey")!.props!.onClick!();
    expect(lastView(p.setters).loaded.pots).toEqual(AFTER); // the write's own re-read is on screen

    slow.resolve(present(BEFORE)); // the Refresh answers late, with the chain as it was before the withdrawal
    await settle();

    // Defect: the page now shows Tax 0.001 USDC again, under "Your withdrawal went through."
    expect(lastView(p.setters).loaded.pots).toEqual(AFTER);
  });

  it("a Refresh that finishes while a write is running does not clear the write's busy note", async () => {
    const slow = deferred<unknown>();
    const signing = deferred<unknown>();
    const withdrawToWallet = vi.fn(() => signing.promise);
    const loadSplit = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(present(AFTER));
    const p = await render({ withdrawToWallet, loadSplit });

    void button(p.tree, "Refresh")!.props!.onClick!();
    await settle();
    const writing = button(p.tree, "Withdraw with my passkey")!.props!.onClick!();
    await settle();
    expect(lastNote(p.setters).busy).toBe("Waiting for your passkey"); // the write is waiting on the passkey

    slow.resolve(present(BEFORE)); // the Refresh ends while the passkey prompt is still open
    await settle();

    // Defect: the note is now { said: undefined }, so the page shows no busy state and enables every button,
    // while the first withdrawal is still waiting on the passkey: a second write can be started.
    expect(lastNote(p.setters).busy).toBeTruthy();

    signing.resolve({ kind: "done", hash: "cd".repeat(32) });
    await writing;
  });
});
