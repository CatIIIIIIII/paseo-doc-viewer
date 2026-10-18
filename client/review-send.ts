import type { ReviewMessage } from "./review-message";

export interface RecipientAgent {
  readonly id: string;
  readonly workspaceId?: string;
  readonly provider: string;
  readonly title: string | null;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly updatedAt: string;
  readonly pendingPermissions: readonly unknown[];
  readonly archivedAt?: string | null;
  readonly providerUnavailable?: boolean;
}

export interface ReviewRecipient extends RecipientAgent {
  readonly ready: boolean;
}

interface AgentHandle {
  refresh(): Promise<{ agent: RecipientAgent } | null>;
  send(text: string, options: { activeTurnBehavior: "steer"; images?: { data: string; mimeType: string }[] }): Promise<void>;
}

export interface ReviewAgents {
  ref(agentId: string): AgentHandle;
}

export type SendOutcome = { status: "sent" } | { status: "busy"; label: string } | { status: "missing" };

// Only an agent with no turn in progress takes the review, so the send does not interrupt a turn
// it can see or clear a pending permission. A closed agent is one the daemon has not loaded since
// it started; sending reopens it.
function isReady(agent: RecipientAgent): boolean {
  const settled = agent.status === "idle" || agent.status === "error" || agent.status === "closed";
  return settled && agent.pendingPermissions.length === 0 && !agent.providerUnavailable;
}

const isOpen = (agent: RecipientAgent) => !agent.archivedAt;

export function recipientStatusLabel(agent: RecipientAgent): string {
  if (agent.pendingPermissions.length > 0) return "Waiting for permission";
  if (agent.providerUnavailable) return "Provider unavailable";
  switch (agent.status) {
    case "idle":
      return "Idle";
    case "error":
      return "Last turn failed";
    case "running":
      return "Busy";
    case "initializing":
      return "Starting";
    case "closed":
      return "Inactive";
  }
}

export function reviewRecipients(agents: readonly RecipientAgent[], workspaceId: string): ReviewRecipient[] {
  return agents
    .filter((agent) => agent.workspaceId === workspaceId && isOpen(agent))
    .map((agent) => ({ ...agent, ready: isReady(agent) }))
    .sort((a, b) => Number(b.ready) - Number(a.ready) || b.updatedAt.localeCompare(a.updatedAt));
}

// Preselected recipient: the most recently active agent that is idle right now. Recipients are
// already sorted ready first, newest first; an agent whose last turn failed or that is not loaded is
// never preselected.
export function defaultRecipient(recipients: readonly ReviewRecipient[]): ReviewRecipient | undefined {
  return recipients.find((agent) => agent.ready && agent.status === "idle");
}

// The reviewer's pick wins. Otherwise the agent preselected earlier stays selected while it is
// listed, also once it turns busy, so the selection never moves to another agent on its own.
export function selectedRecipientId(recipients: readonly ReviewRecipient[], picked: string | null, preselected: string | null): string | null {
  if (picked !== null) return picked;
  if (preselected !== null && recipients.some((agent) => agent.id === preselected)) return preselected;
  return defaultRecipient(recipients)?.id ?? null;
}

// The agent's state is read again right before sending, with nothing awaited in between, and the
// send never asks for "interrupt". Residual race: a turn that starts between the two calls gets the
// review steered into it on providers that can steer, and replaced on the others, because the
// daemon's "steer" falls back to replacing the turn. Closing it needs an idle-only send in Paseo.
export async function sendReview(agents: ReviewAgents, agentId: string, message: ReviewMessage): Promise<SendOutcome> {
  const handle = agents.ref(agentId);
  const current = (await handle.refresh())?.agent;
  if (!current || !isOpen(current)) return { status: "missing" };
  if (!isReady(current)) return { status: "busy", label: recipientStatusLabel(current) };
  await handle.send(message.text, { activeTurnBehavior: "steer", ...(message.images.length > 0 ? { images: [...message.images] } : {}) });
  return { status: "sent" };
}
