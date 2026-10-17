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

// Audit (post 0.4.0): OVERVIEW promises "a busy agent is never interrupted", but sendReview checks
// readiness with refresh() and then calls send(..., { activeTurnBehavior: "steer" }). If a turn
// starts in that window, the daemon's steerOrReplaceActiveTurn replaces (interrupts) the turn on any
// provider without autonomous steering (agent-manager.ts:2869-2886 returns status "replaced"). The
// protocol has no enqueue option, so the plugin cannot keep its own guarantee once the race occurs.

describe("audit: review send race", () => {
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
