import { build } from "esbuild";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./helpers";

const SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/server/usage",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/client/ui",
];

export type Target = "client" | "server";

export async function compileLikePaseo(target: Target, entry?: string): Promise<string> {
  const result = await build({
    entryPoints: [entry ?? join(PLUGIN_ROOT, target === "server" ? "index.server.ts" : "index.client.tsx")],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    mainFields: target === "client" ? ["module", "main"] : undefined,
    supported: target === "client" ? { "async-await": false } : undefined,
    external:
      target === "client"
        ? [...SDK_SPECIFIERS, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"]
        : [...SDK_SPECIFIERS, "zod"],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`${target} compilation produced no output`);
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${output.replaceAll("get: () => from[key]", "value: from[key]")}\nreturn module.exports;\n})`;
}

export function evaluateBundle<T>(bundle: string, requireModule: (name: string) => unknown): T {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle) as (require: (name: string) => unknown) => { default?: unknown };
  const setup = factory(requireModule).default;
  if (typeof setup !== "function") throw new Error("bundle must default export a function");
  return setup as T;
}
