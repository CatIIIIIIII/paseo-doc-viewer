import type { PluginButton, PluginClientContext, PluginHeaderButtonContribution } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { addDocumentsHeaderButtons } from "../client/header-button";
import { DOCUMENTS_PANEL_ID } from "../client/recent";

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
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    client: client as unknown as Pick<PluginClientContext, "paseo" | "addHeaderButton" | "openPanel">,
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
  it("adds one Documents button to each workspace header, following the workspace list", async () => {
    const fake = fakeClient();
    addDocumentsHeaderButtons(fake.client);
    expect(fake.list).toHaveBeenCalledWith({ subscribe: {} });
    await fake.settle();

    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }, { id: "ws-2" }] });
    expect([...fake.live.keys()]).toEqual(["ws-1", "ws-2"]);

    fake.observer()!.update(upsert("ws-2"));
    fake.observer()!.update(upsert("ws-3"));
    fake.observer()!.update(removal("ws-1"));
    fake.observer()!.update({ type: "agent_update", payload: { kind: "remove", agentId: "ws-2" } });
    expect([...fake.live.keys()].sort()).toEqual(["ws-2", "ws-3"]);

    fake.observer()!.snapshot({ entries: [{ id: "ws-3" }, { id: "ws-4" }] });
    expect([...fake.live.keys()].sort()).toEqual(["ws-3", "ws-4"]);
  });

  it("opens the Documents panel in that workspace", async () => {
    const fake = fakeClient();
    addDocumentsHeaderButtons(fake.client);
    await fake.settle();
    fake.observer()!.snapshot({ entries: [{ id: "ws-1" }] });
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.live.size).toBe(0);
    warn.mockRestore();
  });
});
