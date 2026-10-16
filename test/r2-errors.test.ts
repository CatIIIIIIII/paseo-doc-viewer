import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { describeError } from "../client/format";
import { retryPage } from "../client/paging";
import { openDocument } from "../server/documents";
import { workspaceRoot } from "../server/paths";
import { ERROR_MESSAGES, errorCode, errorText } from "../shared/errors";
import { FIXTURES, workspace } from "./helpers";
import { docxEntries, rawZip } from "./zip-builder";

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail");
}

function encryptedZipFlags(zip: Buffer): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i < out.length - 4; i++) {
    if (out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 3 && out[i + 3] === 4) out[i + 6] |= 1;
    if (out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 1 && out[i + 3] === 2) out[i + 8] |= 1;
  }
  return out;
}

function compoundFile(streams: string[]): Buffer {
  const sector = 512;
  const file = Buffer.alloc(sector * 3, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
  file.writeUInt16LE(0x3e, 0x18);
  file.writeUInt16LE(3, 0x1a);
  file.writeUInt16LE(0xfffe, 0x1c);
  file.writeUInt16LE(9, 0x1e);
  file.writeUInt16LE(6, 0x20);
  file.writeUInt32LE(1, 0x2c);
  file.writeUInt32LE(1, 0x30);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(0xfffffffe, 0x3c);
  file.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) file.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 0x4c + i * 4);
  const fat = sector;
  for (let i = 0; i < sector / 4; i++) file.writeUInt32LE(0xffffffff, fat + i * 4);
  file.writeUInt32LE(0xfffffffd, fat);
  file.writeUInt32LE(0xfffffffe, fat + 4);
  const directory = sector * 2;
  ["Root Entry", ...streams].forEach((name, i) => {
    const at = directory + i * 128;
    const encoded = Buffer.from(`${name}\0`, "utf16le");
    encoded.copy(file, at);
    file.writeUInt16LE(encoded.length, at + 64);
    file[at + 66] = i === 0 ? 5 : 2;
  });
  return file;
}

describe("R2: errors carry a parseable code", () => {
  it.each([
    ["deck.pptx", "encrypted_office", () => encryptedZipFlags(readFileSync(join(FIXTURES, "deck.pptx")))],
    ["book.xlsx", "encrypted_office", () => encryptedZipFlags(readFileSync(join(FIXTURES, "invoices.xlsx")))],
    ["contract.docx", "encrypted_office", () => encryptedZipFlags(readFileSync(join(FIXTURES, "contract.docx")))],
    ["protected.xlsx", "encrypted_office", () => compoundFile(["\u0006DataSpaces", "EncryptionInfo", "EncryptedPackage"])],
    ["protected.docx", "encrypted_office", () => compoundFile(["EncryptionInfo", "EncryptedPackage"])],
    ["old.xlsx", "legacy_format", () => compoundFile(["Workbook", "\u0005SummaryInformation"])],
    ["legacy.docx", "legacy_format", () => readFileSync(join(FIXTURES, "legacy-format.docx"))],
    ["locked.pdf", "password_protected", () => readFileSync(join(FIXTURES, "locked.pdf"))],
    ["truncated.pdf", "damaged", () => readFileSync(join(FIXTURES, "truncated.pdf"))],
    ["not-really.xlsx", "damaged", () => readFileSync(join(FIXTURES, "not-really.xlsx"))],
  ])("%s fails with %s", async (name, code, bytes) => {
    const root = workspace({ [name]: bytes() });
    expect(errorCode(await failure(() => openDocument({ root, path: name })))).toBe(code);
  });

  it("a PDF with certificate security gets its own code and message", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.context.trailerInfo.Encrypt = document.context.obj({ Filter: "Adobe.PubSec", SubFilter: "adbe.pkcs7.s5", V: 4, R: 4, Length: 128 });
    const root = workspace({ "cert.pdf": await document.save({ useObjectStreams: false }) });
    const error = await failure(() => openDocument({ root, path: "cert.pdf" }));
    expect(errorCode(error)).toBe("unsupported_encryption");
    expect(error.message).toMatch(/certificate/i);
  });

  it("a damaged docx does not leak third-party parser text", async () => {
    const entries = docxEntries("").filter((entry) => entry.name !== "word/document.xml");
    const root = workspace({ "empty.docx": rawZip(entries) });
    const error = await failure(() => openDocument({ root, path: "empty.docx" }));
    expect(errorCode(error)).toBe("damaged");
    expect(error.message).toBe(ERROR_MESSAGES.invalidOffice("docx"));
  });

  it("filenames never influence classification", async () => {
    const root = workspace({ "exports.xls/summary.pdf": readFileSync(join(FIXTURES, "statement.pdf")) });
    const error = await failure(() => openDocument({ root, path: "exports.xls/missing.pdf" }));
    expect(errorCode(error)).toBe("not_found");
    expect(describeError(error).title).toBe("File not found");
    const ppt = await failure(() => openDocument({ root, path: "report.ppt.pdf" }));
    expect(describeError(ppt).title).toBe("File not found");
  });

  it("an unknown workspace is distinct from a missing file", async () => {
    const paseo = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    const error = await failure(() => workspaceRoot(paseo as never, "ws-123"));
    expect(errorCode(error)).toBe("workspace_not_found");
    expect(describeError(error).title).not.toBe("File not found");
  });
});

describe("R2: the client maps errors by code", () => {
  it("reads the code through the host's Request failed prefix", () => {
    const error = new Error(`Request failed: ${ERROR_MESSAGES.pdfEncrypted()}`);
    expect(errorCode(error)).toBe("password_protected");
    expect(describeError(error).title).toBe("This PDF is password protected");
  });

  it.each([
    [ERROR_MESSAGES.encryptedOffice(), "This file is password protected"],
    [ERROR_MESSAGES.legacyOffice(), "Legacy Office format"],
    [ERROR_MESSAGES.fileTooLarge(700 * 1024 * 1024, 512 * 1024 * 1024), "Too large to preview"],
    [ERROR_MESSAGES.outsideWorkspace(), "Outside the workspace"],
    [ERROR_MESSAGES.fileNotFound("a.pdf"), "File not found"],
    [ERROR_MESSAGES.workspaceNotFound("ws"), "Workspace not found"],
    [ERROR_MESSAGES.pdfDamaged(), "The file looks damaged"],
    [ERROR_MESSAGES.unsupportedType("xyz"), "Unsupported file"],
    ["Plugin RPC timed out: doc-viewer.doc.page", "The host took too long to respond"],
  ])("maps %j to %j", (message, title) => {
    expect(describeError(new Error(message)).title).toBe(title);
  });

  it("strips the host's plugin RPC envelope from the shown text", () => {
    const envelope = (message: string) =>
      new Error(`Request failed: ${message} requestType=plugin.rpc.invoke.request code=handler_error`);
    expect(errorCode(envelope(ERROR_MESSAGES.busy()))).toBe("timeout");
    expect(errorText(envelope(ERROR_MESSAGES.busy()))).toBe("The viewer is busy with other documents; try again");
    expect(errorText(envelope("Plugin service is unavailable"))).toBe("Plugin service is unavailable");
    expect(describeError(envelope(ERROR_MESSAGES.pdfDamaged())).detail).toBe("PDF is damaged or invalid");
  });

  it.each([
    "Plugin process exited: paseo-doc-viewer",
    "Plugin is not available: paseo-doc-viewer",
    "Plugin stopped: paseo-doc-viewer",
  ])("maps the host's %j to stopped and does not retry it", (message) => {
    const error = new Error(`Request failed: ${message} requestType=plugin.rpc.invoke.request code=handler_error`);
    expect(errorCode(error)).toBe("stopped");
    expect(errorText(error)).toBe(message);
    expect(describeError(error)).toMatchObject({
      title: "The document viewer stopped",
      detail: "Reload the plugin or restart Paseo",
    });
    expect(retryPage(0, error)).toBe(false);
  });

  it("does not guess from free text", () => {
    expect(describeError(new Error("legacy password damaged not found")).title).toBe("Unable to open document");
  });

  it("never shows the code tag to the user", () => {
    expect(describeError(new Error(ERROR_MESSAGES.outOfRange("Page", 4, 3))).detail).not.toContain("[doc:");
  });
});
