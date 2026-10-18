import { describe, expect, it, vi } from "vitest";
import { sendReview, type RecipientAgent } from "../client/review-send";

const idle = (overrides: Partial<RecipientAgent> = {}): RecipientAgent => ({
  id: "a",
  workspaceId: "ws",
  provider: "codex",
  title: "Agent",
  status: "idle",
  updatedAt: "2026-10-17T10:00:00.000Z",
  pendingPermissions: [],
  ...overrides,
});

const message = { text: "Review notes", images: [] as { data: string; mimeType: string }[] };

// Audit (post 0.4.0): OVERVIEW promised "a busy agent is never interrupted", but sendReview checks
// readiness with refresh() and then calls send(..., { activeTurnBehavior: "steer" }). If a turn
// starts in that window, the daemon's steerOrReplaceActiveTurn replaces (interrupts) the turn on any
// provider without autonomous steering (agent-manager.ts:2869-2886 returns status "replaced"). The
// protocol has only "interrupt" and "steer", so the plugin cannot close the window; OVERVIEW now
// states the gap exactly, and the tests below pin what the plugin does guarantee.

describe("audit: review send race", () => {
  it("reads the agent again right before sending and refuses a busy one", async () => {
    const send = vi.fn(async () => {});
    const refresh = vi.fn(async () => ({ agent: idle({ status: "running" }) }));
    const outcome = await sendReview({ ref: () => ({ refresh, send }) }, "a", message);
    expect(outcome).toEqual({ status: "busy", label: "Busy" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an agent waiting for a permission", async () => {
    const send = vi.fn(async () => {});
    const refresh = vi.fn(async () => ({ agent: idle({ pendingPermissions: [{}] }) }));
    expect((await sendReview({ ref: () => ({ refresh, send }) }, "a", message)).status).toBe("busy");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends right after one fresh read and never asks for an interrupt", async () => {
    const order: string[] = [];
    const refresh = vi.fn(async () => {
      order.push("refresh");
      return { agent: idle() };
    });
    const send = vi.fn(async (_text: string, _options: { activeTurnBehavior: "steer" }) => {
      order.push("send");
    });
    expect(await sendReview({ ref: () => ({ refresh, send }) }, "a", message)).toEqual({ status: "sent" });
    expect(order).toEqual(["refresh", "send"]);
    expect(send.mock.calls[0]![1].activeTurnBehavior).toBe("steer");
  });

  // Residual, not fixable in the plugin: needs an idle-only send in Paseo.
  it.fails("does not send once the agent becomes busy after the readiness check", async () => {
    let snapshot = idle();
    const send = vi.fn(async () => {
      // A turn began between refresh() and this send: a non-steering provider will now be interrupted.
      snapshot = idle({ status: "running" });
    });
    const refresh = vi.fn(async () => ({ agent: snapshot }));
    const agents = { ref: () => ({ refresh, send }) };
    const outcome = await sendReview(agents, "a", message);
    expect(outcome.status).toBe("busy");
    expect(send).not.toHaveBeenCalled();
  });
});
