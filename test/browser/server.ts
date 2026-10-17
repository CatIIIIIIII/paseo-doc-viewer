import { createServer } from "node:http";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../../index.server";
import { ViewerStateStore, positionKey } from "../../server/viewer-state";
import { searchDocument } from "../../server/documents";
import { readFileSync } from "node:fs";
import { DOCUMENT_RPCS } from "../../shared/rpc";
const root = mkdtempSync(join(tmpdir(), "viewer-browser-files-"));
const state = mkdtempSync(join(tmpdir(), "viewer-browser-state-"));
const store = new ViewerStateStore(state);
for (const file of ["statement.pdf", "invoices.xlsx", "contract.docx", "deck.pptx", "audible.webm"]) copyFileSync(join(process.cwd(), "test/fixtures", file), join(root, file));
copyFileSync(join(process.cwd(), "node_modules/.cache/viewer-browser/searchable.pdf"), join(root, "statement.pdf"));
writeFileSync(join(root, "broken.pdf"), "original unsupported file");
writeFileSync(join(root, ".env"), "SECRET=1");
writeFileSync(join(root, "many.csv"), Array.from({ length: 120 }, (_, row) => `row ${row},needle`).join("\n"));
const bytes = Buffer.alloc(44 + 16000);
bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16000, 40);
for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 8000), 44 + i * 2);
writeFileSync(join(root, "tone.wav"), bytes);
const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
contribute({ handle: (contract: any, handler: any) => handlers.set(contract.name, handler) } as any);
// A tiny budget makes every search span many requests, so the client must keep going on its own.
handlers.set("doc.search", async ({ path, password, query, cursor }) => searchDocument({ root, path, password }, query, cursor, 1));
handlers.set("viewer-state.read", async ({ path }) => ({ saved: await store.read(await positionKey(root, path)) }));
handlers.set("viewer-state.write", async ({ path, revision, position }) => { await store.write(await positionKey(root, path), revision, position); return { saved: true }; });
const paseo = { workspaces: { list: async () => ({ entries: [{ id: "workspace", workspaceDirectory: root }], pageInfo: { hasMore: false } }) } };
const server = createServer(async (request, response) => {
  if (request.url === "/bundle.js") { response.setHeader("Content-Type", "application/javascript"); response.end(readFileSync(join(process.cwd(), "node_modules/.cache/viewer-browser/app.js"))); return; }
  if (request.url !== "/rpc") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><head><meta charset="utf-8"><title>Viewer test harness</title></head><body style="background:#111827;color:#e5e7eb;font-family:system-ui"><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
  try {
    let body = ""; for await (const part of request) body += part;
    const { method, input } = JSON.parse(body);
    const contract = DOCUMENT_RPCS.find((rpc) => rpc.name === method)!;
    const output = await handlers.get(method)!(contract.input.parse(input), { paseo });
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(contract.output.parse(output)));
  } catch (error) { response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify(server.address()) + "\n"));
process.on("SIGTERM", () => { server.close(); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); process.exit(0); });
