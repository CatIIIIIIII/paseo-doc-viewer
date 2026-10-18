// Validates the manifest and compiles this plugin with Paseo's own code, then evaluates the server bundle with
// Paseo's own evaluator, all loaded from a Paseo source checkout. Run with that checkout's tsx:
//   <paseo>/node_modules/.bin/tsx scripts/paseo-compile.mts <paseo> <plugin-dir> <out-dir> <workspace>
// Writes client.js, server.js and result.json ({ error } or { handlers, page, webp }) into out-dir.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [paseo, pluginDir, outDir, workspace] = process.argv.slice(2);
const plugins = join(paseo, "packages/server/src/server/plugins");
mkdirSync(outDir, { recursive: true });
const finish = (result: object) => writeFileSync(join(outDir, "result.json"), JSON.stringify(result));

const { compilePlugin } = await import(join(plugins, "compiler.ts"));
const { evaluateBundle } = await import(join(plugins, "bundle-evaluator.ts"));
const { readPluginManifest } = await import(join(plugins, "manifest.ts"));

try {
  await readPluginManifest(pluginDir);
} catch (error) {
  finish({ error: `manifest: ${(error as Error).message}` });
  process.exit(0);
}

let bundles: { clientBundle: string; serverBundle: string };
try {
  bundles = await compilePlugin({
    client: join(pluginDir, "index.client.tsx"),
    server: join(pluginDir, "index.server.ts"),
  });
} catch (error) {
  finish({ error: (error as Error).message });
  process.exit(0);
}
writeFileSync(join(outDir, "client.js"), bundles.clientBundle);
writeFileSync(join(outDir, "server.js"), bundles.serverBundle);

const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
evaluateBundle(bundles.serverBundle)({
  registerSettings: () => ({ read: async () => ({ status: "ready", revision: "", values: { turnCards: true } }), subscribe: () => () => {} }), on: () => () => {},
  handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler),
} as never);
const paseoApi = {
  workspaces: {
    list: async () => ({
      entries: [{ id: "ws-1", workspaceDirectory: workspace, projectRootPath: workspace }],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }),
  },
};
const page = await handlers.get("doc.page")?.({ workspaceId: "ws-1", path: "statement.pdf", index: 0 }, { paseo: paseoApi });
const webp = await handlers.get("doc.page")?.({ workspaceId: "ws-1", path: "animated.webp", index: 0 }, { paseo: paseoApi });
finish({ handlers: [...handlers.keys()], page, webp });
