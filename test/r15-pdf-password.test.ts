import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { cacheKeys } from "../server/cache";
import { openDocument, readPageText, renderPage } from "../server/documents";
import { PDFIUM_IDLE_MS, pdfPageCount, readPdfPageText } from "../server/pdf";
import { errorCode } from "../shared/errors";
import { docOpenRpc, docPageRpc, docTextRpc } from "../shared/rpc";
import { describeError } from "../client/format";
import { passwordPrompt } from "../client/password";
import { decodePng, inkRatio, workspaceWithFixtures } from "./helpers";

const PASSWORD = "secret";
const WRONG = "hunter2-wrong";
const failure = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error as Error);

let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectNoPassword(...values: unknown[]) {
  const text = JSON.stringify([values, logged, cacheKeys()], (_key, value: unknown) =>
    value instanceof Error ? `${value.message}\n${value.stack}` : value,
  );
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(WRONG);
}

describe("R15: password-protected PDFs open with a password", () => {
  it("asks for a password, rejects a wrong one, and renders with the right one", async () => {
    const root = workspaceWithFixtures("locked.pdf", "statement.pdf");
    const required = await failure(() => openDocument({ root, path: "locked.pdf" }));
    expect(errorCode(required)).toBe("password_required");
    const incorrect = await failure(() => openDocument({ root, path: "locked.pdf", password: WRONG }));
    expect(errorCode(incorrect)).toBe("password_incorrect");

    const ref = { root, path: "locked.pdf", password: PASSWORD };
    expect(await openDocument(ref)).toMatchObject({ kind: "pdf", pageCount: 3 });
    const page = await renderPage(ref, { index: 1, maxWidth: 400 });
    const plain = await renderPage({ root, path: "statement.pdf" }, { index: 1, maxWidth: 400 });
    if (page.kind !== "pdf" || plain.kind !== "pdf") throw new Error("expected PDF pages");
    expect(inkRatio(decodePng(page.image.data))).toBeGreaterThan(0.001);
    expect(page.image.data).toBe(plain.image.data);
    const text = await readPageText(ref, { index: 0 });
    expect(text).toMatchObject({ kind: "pdf", index: 0, pageCount: 3 });
    expectNoPassword(required, incorrect, page, text);
  });

  it("does not serve pages rendered with the password to requests without it", async () => {
    const root = workspaceWithFixtures("locked.pdf");
    await renderPage({ root, path: "locked.pdf", password: PASSWORD }, { index: 0 });
    await readPageText({ root, path: "locked.pdf", password: PASSWORD }, { index: 0 });
    expect(errorCode(await failure(() => renderPage({ root, path: "locked.pdf" }, { index: 0 })))).toBe("password_required");
    expect(errorCode(await failure(() => readPageText({ root, path: "locked.pdf", password: WRONG }, { index: 0 })))).toBe(
      "password_incorrect",
    );
    expectNoPassword();
  });

  it("reopens with the resent password after PDFium is recycled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = workspaceWithFixtures("locked.pdf");
    const file = { path: join(root, "locked.pdf"), revision: "1", size: 1024, password: PASSWORD, passwordKey: "k1" };
    expect(await pdfPageCount(file)).toBe(3);
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS);
    expect(await readPdfPageText(file, 0)).toMatchObject({ pageCount: 3 });
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS);
    const locked = { ...file, password: undefined, passwordKey: "" };
    expect(errorCode(await failure(() => pdfPageCount(locked)))).toBe("password_required");
  });

  it("accepts the password on doc.open, doc.page and doc.text and passes it through the server", async () => {
    for (const contract of [docOpenRpc, docPageRpc, docTextRpc]) {
      expect(contract.input.parse({ workspaceId: "ws", path: "a.pdf", index: 0, password: PASSWORD })).toMatchObject({ password: PASSWORD });
    }
    const root = workspaceWithFixtures("locked.pdf");
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    contribute({ registerSettings: () => ({ read: async () => ({ status: "ready", revision: "", values: { turnCards: true } }), subscribe: () => () => {} }), on: () => () => {}, handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler) } as never);
    const paseo = {
      workspaces: {
        list: async () => ({ entries: [{ id: "ws", workspaceDirectory: root, projectRootPath: root }], pageInfo: { hasMore: false } }),
      },
    };
    const input = { workspaceId: "ws", path: "locked.pdf", password: PASSWORD };
    expect(await handlers.get("doc.open")!(input, { paseo })).toMatchObject({ pageCount: 3 });
    expect(await handlers.get("doc.page")!({ ...input, index: 2 }, { paseo })).toMatchObject({ kind: "pdf", index: 2 });
    expect(await handlers.get("doc.text")!({ ...input, index: 2 }, { paseo })).toMatchObject({ kind: "pdf", index: 2 });
  });
});

describe("R15: the client asks for the password", () => {
  it("prompts on a missing or wrong password and shows other errors as before", () => {
    const tagged = (code: string) => new Error(`Request failed: [doc:${code}] text`);
    expect(passwordPrompt(tagged("password_required"))).toEqual({ incorrect: false });
    expect(passwordPrompt(tagged("password_incorrect"))).toEqual({ incorrect: true });
    expect(passwordPrompt(tagged("damaged"))).toBeNull();
    expect(passwordPrompt(null)).toBeNull();
    expect(describeError(tagged("password_incorrect")).title).toBe("Incorrect password");
  });
});
