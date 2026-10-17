import type { PluginButton, PluginClientContext, PluginHeaderButtonContribution } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDocumentsHeaderButtons, HEADER_POLL_MAX_MS, HEADER_POLL_MS } from "../client/header-button";
import { DOCUMENTS_PANEL_ID } from "../client/recent";
import { docsRecentRpc } from "../shared/rpc";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

interface Observer {
  snapshot(snapshot: { entries: { id: string }[] }): void;
  update(message: unknown): void;
}

function fakeClient() {
  const live = new Map<string, PluginButton>();
  let observer: Observer | null = null;
  let resolveList!: () => void;
  const release = vi.fn(async () => {});
  const listed = new Promise<void>((resolve) => (resolveList = resolve));
  const client = {
    rpc: vi.fn(async (_contract: unknown, _request: unknown) => ({ entries: [{ path: "report.pdf" }] })),
    openPanel: vi.fn(),
    addHeaderButton: vi.fn(({ workspaceId, button }: PluginHeaderButtonContribution) => {
      if (live.has(workspaceId)) throw new Error(`duplicate header button for ${workspaceId}`);
      live.set(workspaceId, button);
      return { update: vi.fn(), remove: () => void live.delete(workspaceId) };
    }),
    paseo: {
      workspaces: {
        list: vi.fn(async () => {
          await listed;
          return {
            entries: [],
            subscription: {
              subscribe: (next: Observer) => {
                observer = next;
                return () => (observer = null);
              },
              release,
            },
          };
        }),
      },
    },
  };
  const settle = async () => {
    resolveList();
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    client: client as unknown as Pick<PluginClientContext, "paseo" | "rpc" | "addHeaderButton" | "openPanel">,
    rpc: client.rpc,
    openPanel: client.openPanel,
    list: client.paseo.workspaces.list,
    live,
    release,
    settle,
    observer: () => observer,
  };
}

const upsert = (id: string) => ({ type: "workspace_update", payload: { kind: "upsert", workspace: { id } } });
const removal = (id: string) => ({ type: "workspace_update", payload: { kind: "remove", id } });

describe("Documents header button", () => {
  it("stays hidden for empty workspaces and follows document creation and deletion", async () => {
    const fake = fakeClient();
    fake.rpc.mockResolvedValue({ entries: [] });
    const cleanup = addDocumentsHeaderButtons(fake.client);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    expect(fake.rpc).toHaveBeenCalledWith(docsRecentRpc, { workspaceId: "ws-1", limit: 1 });
    expect(fake.live.size).toBe(0);

    fake.rpc.mockResolvedValue({ entries: [{ path: "report.pdf" }] });
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect([...fake.live.keys()]).toEqual(["ws-1"]);

    fake.rpc.mockRejectedValueOnce(new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect([...fake.live.keys()]).toEqual(["ws-1"]);

    fake.rpc.mockResolvedValue({ entries: [] });
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect([...fake.live.keys()]).toEqual(["ws-1"]);
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect(fake.live.size).toBe(0);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off polling while a workspace keeps failing, then resumes the normal interval", async () => {
    const fake = fakeClient();
    fake.rpc.mockRejectedValue(new Error("unavailable"));
    const cleanup = addDocumentsHeaderButtons(fake.client);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // First call, retries at 1, 3 and 7 minutes, then every 5 minutes.
    expect(fake.rpc).toHaveBeenCalledTimes(1 + 3 + Math.floor((30 * 60_000 - 420_000) / HEADER_POLL_MAX_MS));
    fake.rpc.mockResolvedValue({ entries: [] });
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MAX_MS);
    const calls = fake.rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    expect(fake.rpc).toHaveBeenCalledTimes(calls + 1);
    cleanup();
  });

  it("discards pending results after removal, re-addition, and cleanup", async () => {
    const fake = fakeClient();
    let resolve!: (result: { entries: { path: string }[] }) => void;
    fake.rpc.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const cleanup = addDocumentsHeaderButtons(fake.client);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    fake.observer()!.update(removal("ws-1"));
    fake.rpc.mockResolvedValue({ entries: [] });
    fake.observer()!.update(upsert("ws-1"));
    resolve({ entries: [{ path: "stale.pdf" }] });
    await fake.settle();
    expect(fake.live.size).toBe(0);

    let finish!: (result: { entries: { path: string }[] }) => void;
    fake.rpc.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    await vi.advanceTimersByTimeAsync(HEADER_POLL_MS);
    cleanup();
    finish({ entries: [{ path: "late.pdf" }] });
    await fake.settle();
    expect(fake.live.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("adds one Documents button to each nonempty workspace header, following the workspace list", async () => {
    const fake = fakeClient();
    addDocumentsHeaderButtons(fake.client);
    expect(fake.list).toHaveBeenCalledWith({ subscribe: {} });
    await fake.settle();

    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }, { id: "ws-2" }] });
    await fake.settle();
    expect([...fake.live.keys()]).toEqual(["ws-1", "ws-2"]);

    fake.observer()!.update(upsert("ws-2"));
    fake.observer()!.update(upsert("ws-3"));
    fake.observer()!.update(removal("ws-1"));
    fake.observer()!.update({ type: "agent_update", payload: { kind: "remove", agentId: "ws-2" } });
    await fake.settle();
    expect([...fake.live.keys()].sort()).toEqual(["ws-2", "ws-3"]);

    fake.observer()!.snapshot({ entries: [{ id: "ws-3" }, { id: "ws-4" }] });
    await fake.settle();
    expect([...fake.live.keys()].sort()).toEqual(["ws-3", "ws-4"]);
  });

  it("opens the Documents panel in that workspace", async () => {
    const fake = fakeClient();
    addDocumentsHeaderButtons(fake.client);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    const button = fake.live.get("ws-1")!;
    expect(button).toMatchObject({ title: "Show documents", icon: "FileStack", label: "Documents" });
    if (button.behavior.kind !== "action") throw new Error("expected an action button");
    await button.behavior.onPress();
    expect(fake.openPanel).toHaveBeenCalledWith(DOCUMENTS_PANEL_ID, { workspaceId: "ws-1" });
  });

  it("removes its buttons and releases the workspace subscription on cleanup", async () => {
    const fake = fakeClient();
    const cleanup = addDocumentsHeaderButtons(fake.client);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
    await fake.settle();
    cleanup();
    expect(fake.live.size).toBe(0);
    expect(fake.observer()).toBeNull();
    expect(fake.release).toHaveBeenCalled();
  });

  it("releases a subscription that arrives after cleanup without adding buttons", async () => {
    const fake = fakeClient();
    const cleanup = addDocumentsHeaderButtons(fake.client);
    cleanup();
    await fake.settle();
    expect(fake.release).toHaveBeenCalled();
    expect(fake.observer()).toBeNull();
    expect(fake.live.size).toBe(0);
  });

  it("keeps the plugin working when the workspace list cannot be observed", async () => {
    const fake = fakeClient();
    fake.list.mockRejectedValueOnce(new Error("socket closed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => addDocumentsHeaderButtons(fake.client)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.live.size).toBe(0);
    warn.mockRestore();
  });
});
