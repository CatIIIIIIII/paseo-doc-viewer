import { describe, expect, it, vi } from "vitest";
import { defaultRecipient, recipientStatusLabel, reviewRecipients, selectedRecipientId, sendReview, type RecipientAgent } from "../client/review-send";

const agent = (id: string, overrides: Partial<RecipientAgent> = {}): RecipientAgent => ({
  id,
  workspaceId: "ws",
  provider: "claude",
  title: `Agent ${id}`,
  status: "idle",
  updatedAt: "2026-10-17T10:00:00.000Z",
  pendingPermissions: [],
  ...overrides,
});

function fakeAgents(snapshot: RecipientAgent | null, send = vi.fn(async () => {})) {
  const refresh = vi.fn(async () => (snapshot ? { agent: snapshot, project: null } : null));
  return { agents: { ref: vi.fn(() => ({ refresh, send })) }, refresh, send };
}

const message = { text: "Review notes", images: [{ data: "AAAA", mimeType: "image/png" }] };

describe("review recipients", () => {
  it("preselects the most recently active idle agent, never a busy, failed or unloaded one", () => {
    const pick = (agents: RecipientAgent[]) => defaultRecipient(reviewRecipients(agents, "ws"))?.id;
    expect(pick([
      agent("old", { updatedAt: "2026-10-17T09:00:00.000Z" }),
      agent("new", { updatedAt: "2026-10-17T11:00:00.000Z" }),
      agent("busy", { status: "running", updatedAt: "2026-10-17T12:00:00.000Z" }),
    ])).toBe("new");
    expect(pick([agent("failed", { status: "error" }), agent("closed", { status: "closed" }), agent("asking", { pendingPermissions: [{}] })])).toBeUndefined();
    expect(pick([])).toBeUndefined();
  });

  it("keeps the preselected agent selected while it is listed, also once it turns busy", () => {
    const listed = (agents: RecipientAgent[]) => reviewRecipients(agents, "ws");
    const docs = (overrides: Partial<RecipientAgent> = {}) => agent("docs", { updatedAt: "2026-10-17T11:00:00.000Z", ...overrides });
    expect(selectedRecipientId(listed([docs(), agent("other")]), null, null)).toBe("docs");
    const docsBusy = listed([docs({ status: "running" }), agent("other")]);
    expect(selectedRecipientId(docsBusy, null, "docs")).toBe("docs");
    expect(selectedRecipientId(listed([docs({ status: "running" })]), null, "docs")).toBe("docs");
    // The reviewer's pick wins, and an agent that left the list gives way to the default.
    expect(selectedRecipientId(docsBusy, "other", "docs")).toBe("other");
    expect(selectedRecipientId(listed([agent("other")]), null, "docs")).toBe("other");
    expect(selectedRecipientId(listed([docs({ archivedAt: "2026-10-17T12:00:00.000Z" })]), null, "docs")).toBeNull();
  });

  it("lists this workspace's unarchived agents, ready ones first and most recent first", () => {
    const recipients = reviewRecipients(
      [
        agent("busy", { status: "running", updatedAt: "2026-10-17T12:00:00.000Z" }),
        agent("old", { updatedAt: "2026-10-17T08:00:00.000Z" }),
        agent("other", { workspaceId: "ws-2" }),
        agent("closed", { status: "closed", updatedAt: "2026-10-17T07:00:00.000Z" }),
        agent("archived", { archivedAt: "2026-10-17T09:00:00.000Z" }),
        agent("failed", { status: "error", updatedAt: "2026-10-17T11:00:00.000Z" }),
        agent("asking", { pendingPermissions: [{}] }),
        agent("new"),
      ],
      "ws",
    );
    expect(recipients.map((each) => [each.id, each.ready])).toEqual([
      ["failed", true],
      ["new", true],
      ["old", true],
      ["closed", true],
      ["busy", false],
      ["asking", false],
    ]);
  });

  it("labels why an agent cannot take the review now", () => {
    expect(recipientStatusLabel(agent("a"))).toBe("Idle");
    expect(recipientStatusLabel(agent("a", { status: "running" }))).toBe("Busy");
    expect(recipientStatusLabel(agent("a", { pendingPermissions: [{}] }))).toBe("Waiting for permission");
    expect(recipientStatusLabel(agent("a", { status: "initializing" }))).toBe("Starting");
    expect(recipientStatusLabel(agent("a", { status: "error" }))).toBe("Last turn failed");
    expect(recipientStatusLabel(agent("a", { status: "closed" }))).toBe("Inactive");
  });
});

describe("send review", () => {
  it("sends text and images to an idle agent without the interrupt default", async () => {
    const fake = fakeAgents(agent("a"));
    await expect(sendReview(fake.agents, "a", message)).resolves.toEqual({ status: "sent" });
    expect(fake.agents.ref).toHaveBeenCalledWith("a");
    expect(fake.send).toHaveBeenCalledWith("Review notes", { activeTurnBehavior: "steer", images: message.images });
  });

  it("omits images when none are attached", async () => {
    const fake = fakeAgents(agent("a"));
    await sendReview(fake.agents, "a", { text: "Plain", images: [] });
    expect(fake.send).toHaveBeenCalledWith("Plain", { activeTurnBehavior: "steer" });
  });

  it("checks the agent again at submission and does not send to one that became busy", async () => {
    const fake = fakeAgents(agent("a", { status: "running" }));
    await expect(sendReview(fake.agents, "a", message)).resolves.toEqual({ status: "busy", label: "Busy" });
    expect(fake.refresh).toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("reports an agent that no longer exists or was archived", async () => {
    expect(await sendReview(fakeAgents(null).agents, "a", message)).toEqual({ status: "missing" });
    const archived = fakeAgents(agent("a", { archivedAt: "2026-10-17T09:00:00.000Z" }));
    expect(await sendReview(archived.agents, "a", message)).toEqual({ status: "missing" });
    expect(archived.send).not.toHaveBeenCalled();
  });

  it("lets a rejected send fail so the caller keeps the draft", async () => {
    const fake = fakeAgents(agent("a"), vi.fn(async () => { throw new Error("sendAgentMessage rejected"); }));
    await expect(sendReview(fake.agents, "a", message)).rejects.toThrow("sendAgentMessage rejected");
  });
});
