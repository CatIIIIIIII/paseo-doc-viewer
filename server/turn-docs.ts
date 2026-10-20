import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { baselineAt, changedDuringTurn, groupChanges, TURN_WINDOW_SLACK_MS, turnDocsRow, type Baseline, type ScannedFile, type ScannedWorkspace, type TurnDocsRow } from "../shared/turn-docs";

type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

// The daemon side of a hook call; the hook context carries the Paseo API.
export interface TurnDocsHost {
  resolveRoot(workspaceId: string): Promise<string>;
  append(agentId: string, row: TurnDocsRow): Promise<unknown>;
}

export interface TurnDocsDeps {
  // `notBefore` lets a scan that began after it be reused; without it the scan is always new.
  scan(root: string, notBefore?: number): Promise<ScannedWorkspace>;
  enabled(): Promise<boolean>;
  now?: () => number;
  log?: (message: string) => void;
}

interface Turn {
  startedAt: number;
  workspaceId: string;
  root: Promise<string>;
  baseline: Promise<Baseline | null>;
}

// One card per finished turn, listing supported documents that changed while it ran. mtime, not tool
// calls: agents write PDFs and spreadsheets from shell scripts, which no write/edit tool detail shows.
export function createTurnDocs(deps: TurnDocsDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.error(`[doc-viewer] ${message}`));
  const turns = new Map<string, Turn>();

  return {
    turnStarted({ agent }: TurnStarted, host: TurnDocsHost): void {
      const startedAt = now();
      if (!agent.workspaceId) return;
      const workspaceId = agent.workspaceId;
      const root = host.resolveRoot(workspaceId);
      // The baseline tells new from changed. It leaves out what changed from the slack before startedAt on,
      // so a file the agent wrote before the scan reached it is judged by the end scan alone. No scan when
      // the setting is off. A scan begun within the slack before startedAt is reused, so turns starting
      // together share a walk, and it still holds every folder made before that.
      const baseline = root
        .then(async (dir): Promise<Baseline | null> => ((await deps.enabled()) ? baselineAt(await deps.scan(dir, startedAt - TURN_WINDOW_SLACK_MS), startedAt) : null))
        .catch(() => null);
      root.catch(() => undefined);
      turns.set(agent.id, { startedAt, workspaceId, root, baseline });
    },

    async turnEnded({ agent, turnId, outcome }: TurnEnded, host: TurnDocsHost): Promise<TurnDocsRow | null> {
      const turn = turns.get(agent.id);
      turns.delete(agent.id);
      // Without a recorded start (the plugin loaded mid-turn) there is no window to judge.
      if (!turn || !(await deps.enabled())) return null;
      const began = now();
      const root = await turn.root;
      const [baseline, after] = await Promise.all([turn.baseline, deps.scan(root)]);
      const candidates = after.entries.filter((entry) => entry.changedMs >= turn.startedAt - TURN_WINDOW_SLACK_MS);
      const changed = changedDuringTurn(baseline?.complete ? candidates : await withBirthtimes(root, candidates), baseline, turn.startedAt);
      const { files, groups } = groupChanges(changed, after, baseline, turn.startedAt);
      const row = turnDocsRow({
        workspaceId: turn.workspaceId,
        turnId,
        startedAt: turn.startedAt,
        endedAt: began,
        outcome: outcome.kind,
        files,
        groups,
        partial: !after.complete,
      });
      const folded = groups.length > 0 ? ` (${changed.length - files.length} in ${groups.length} folder row(s))` : "";
      log(`turn ${turnId ?? "?"} of ${agent.id.slice(0, 8)}: ${changed.length} changed document(s)${folded}, scan ${now() - began} ms${after.complete ? "" : " (partial)"}`);
      if (row) await host.append(agent.id, row);
      return row;
    },

    forget(agentId: string): void {
      turns.delete(agentId);
    },
  };
}

async function withBirthtimes(root: string, files: readonly ScannedFile[]): Promise<ScannedFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const info = await stat(join(root, file.path)).catch(() => null);
      return info ? { ...file, birthtimeMs: info.birthtimeMs } : file;
    }),
  );
}
