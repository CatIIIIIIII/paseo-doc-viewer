import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PLUGIN_ROOT, workspaceWithFixtures } from "./helpers";

const run = promisify(execFile);

function findPaseoSource(): string | null {
  const candidates = process.env.PASEO_SOURCE
    ? [process.env.PASEO_SOURCE]
    : [resolve(PLUGIN_ROOT, "../paseo-main"), resolve(PLUGIN_ROOT, "../worktrees/paseo-main")];
  return (
    candidates.find((dir) =>
      existsSync(join(dir, "packages/server/src/server/plugins/compiler.ts")) &&
      existsSync(join(dir, "node_modules/.bin/tsx")),
    ) ?? null
  );
}

export const PASEO_SOURCE = findPaseoSource();
export const PASEO_SOURCE_MISSING =
  "no Paseo source checkout: set PASEO_SOURCE to a getpaseo/paseo checkout with node_modules installed";

export interface RealCompile {
  error?: string;
  clientBundle: string;
  serverBundle: string;
  handlers: string[];
  page: unknown;
  webp: unknown;
}

export async function compileWithPaseo(pluginDir: string = PLUGIN_ROOT): Promise<RealCompile> {
  if (!PASEO_SOURCE) throw new Error(PASEO_SOURCE_MISSING);
  const out = mkdtempSync(join(tmpdir(), "paseo-real-compile-"));
  await run(
    join(PASEO_SOURCE, "node_modules/.bin/tsx"),
    [join(PLUGIN_ROOT, "scripts/paseo-compile.mts"), PASEO_SOURCE, pluginDir, out, workspaceWithFixtures("statement.pdf", "animated.webp")],
    { cwd: PASEO_SOURCE, maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  if (result.error) return { error: result.error, clientBundle: "", serverBundle: "", handlers: [], page: null, webp: null };
  return {
    ...result,
    clientBundle: readFileSync(join(out, "client.js"), "utf8"),
    serverBundle: readFileSync(join(out, "server.js"), "utf8"),
  };
}

let shared: Promise<RealCompile> | null = null;

export function compiledPlugin(): Promise<RealCompile> {
  shared ??= compileWithPaseo();
  return shared;
}

export function lucideIconNames(): Set<string> | null {
  if (!PASEO_SOURCE) return null;
  const types = join(PASEO_SOURCE, "packages/app/node_modules/lucide-react-native/dist/types/lucide-react-native.d.ts");
  if (!existsSync(types)) return null;
  const source = readFileSync(types, "utf8");
  const icons = new Set([...source.matchAll(/^declare const (\w+): LucideIcon;$/gm)].map((match) => match[1]));
  const names = new Set<string>();
  for (const list of source.matchAll(/^export \{([^}]*)\};?$/gm)) {
    for (const entry of list[1].split(",")) {
      const [local, exported = local] = entry.trim().split(/\s+as\s+/);
      if (icons.has(local)) names.add(exported);
    }
  }
  return names;
}
