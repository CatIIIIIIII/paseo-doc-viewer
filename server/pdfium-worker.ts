import type { MessagePort } from "node:worker_threads";
import type { SearchBox } from "../shared/search";

// The protocol between server/pdfium.ts and the PDFium worker thread.

export interface PdfiumWorkerInit {
  // Source of the Emscripten factory (PDFiumModule) and the names of the two module-level helpers
  // the bundler left it referring to.
  glue: string;
  importMeta: string;
  defineProperty: string;
  wasm: WebAssembly.Module;
}

export type PdfiumRequest =
  | { op: "open"; key: string; bytes: Uint8Array; password?: string }
  | { op: "close"; key: string }
  | { op: "size"; key: string; index: number }
  | { op: "render"; key: string; index: number; width: number; height: number }
  | { op: "text"; key: string; index: number }
  | { op: "boxes"; key: string; index: number; ranges: [start: number, count: number][] };

export interface PdfiumResults {
  open: { pageCount: number };
  close: null;
  size: { width: number; height: number };
  render: { data: Uint8Array };
  text: { text: string };
  boxes: { boxes: SearchBox[][] };
}

// `load` carries FPDF_GetLastError for a document that did not open; `missing` means the worker
// does not hold the document (it was restarted since); `fatal` means the WASM module aborted.
export type PdfiumFailure =
  | { kind: "load"; code: number; certificate: boolean }
  | { kind: "missing" }
  | { kind: "fatal"; message: string }
  | { kind: "error"; message: string };

export type PdfiumResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; failure: PdfiumFailure };

// The parts of the WebAssembly global used here; the project's type libraries do not declare them.
export interface WasmApi {
  compile(bytes: ArrayBuffer): Promise<WebAssembly.Module>;
  instantiate(module: WebAssembly.Module, imports: object): Promise<object>;
  RuntimeError: abstract new (...args: never[]) => Error;
}

// Runs inside the worker from its source text, so it must not refer to anything outside its own
// body except globals: server/pdfium.ts passes the port and init data in.
export function pdfiumWorkerMain(port: MessagePort, init: PdfiumWorkerInit): void {
  interface Module {
    HEAPU8: Uint8Array;
    wasmExports: { malloc(size: number): number; free(ptr: number): void };
    [name: `_${string}`]: (...args: number[]) => number;
  }
  interface Held {
    document: number;
    data: number;
  }
  const RENDER_FLAGS = 1 | 2 | 16; // FPDF_ANNOT | FPDF_LCD_TEXT | FPDF_REVERSE_BYTE_ORDER (RGBA)
  const BGRA = 4;
  const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;
  const define = (target: object, key: PropertyKey, value: unknown) =>
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  const createModule = new Function(init.importMeta, init.defineProperty, `"use strict"; return (${init.glue});`)({}, define) as (
    options: object,
  ) => Promise<Module>;
  let failed: (error: unknown) => void = () => {};
  const instantiation = new Promise<never>((_, reject) => (failed = reject));
  const ready = Promise.race([
    createModule({
      // Abort details reach the host in the failure message; keep the plugin's stderr quiet.
      print() {},
      printErr() {},
      instantiateWasm(imports: object, done: (instance: object, module: WebAssembly.Module) => void) {
        wasm.instantiate(init.wasm, imports).then((instance) => done(instance, init.wasm), failed);
        return {};
      },
    }),
    instantiation,
  ]).then((module) => {
    module._FPDF_InitLibrary();
    return module;
  });
  const documents = new Map<string, Held>();
  const utf16 = new TextDecoder("utf-16le");

  class Missing extends Error {}

  function held(key: string): Held {
    const entry = documents.get(key);
    if (!entry) throw new Missing();
    return entry;
  }

  function withPage<T>(module: Module, key: string, index: number, use: (page: number) => T): T {
    const page = module._FPDF_LoadPage(held(key).document, index);
    if (!page) throw new Error(`Page ${index + 1} could not be loaded`);
    try {
      return use(page);
    } finally {
      module._FPDF_ClosePage(page);
    }
  }

  function withTextPage<T>(module: Module, page: number, use: (textPage: number) => T): T {
    const textPage = module._FPDFText_LoadPage(page);
    if (!textPage) throw new Error("The page text could not be loaded");
    try {
      return use(textPage);
    } finally {
      module._FPDFText_ClosePage(textPage);
    }
  }

  function open(module: Module, key: string, bytes: Uint8Array, password: string | undefined) {
    const data = module.wasmExports.malloc(bytes.length);
    module.HEAPU8.set(bytes, data);
    const secret = password ? new TextEncoder().encode(`${password}\0`) : null;
    const secretPtr = secret ? module.wasmExports.malloc(secret.length) : 0;
    if (secret) module.HEAPU8.set(secret, secretPtr);
    const document = module._FPDF_LoadMemDocument(data, bytes.length, secretPtr);
    if (secretPtr) {
      module.HEAPU8.fill(0, secretPtr, secretPtr + secret!.length);
      module.wasmExports.free(secretPtr);
    }
    if (!document) {
      const code = module._FPDF_GetLastError();
      module.wasmExports.free(data);
      const certificate = (code === 4 || code === 5) && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).includes("/Adobe.PubSec");
      return { failure: { kind: "load", code, certificate } as const };
    }
    documents.set(key, { document, data });
    return { value: { pageCount: module._FPDF_GetPageCount(document) } };
  }

  function close(module: Module, key: string) {
    const entry = documents.get(key);
    if (!entry) return null;
    documents.delete(key);
    module._FPDF_CloseDocument(entry.document);
    module.wasmExports.free(entry.data);
    return null;
  }

  function render(module: Module, key: string, index: number, width: number, height: number) {
    return withPage(module, key, index, (page) => {
      const size = width * height * 4;
      const pixels = module.wasmExports.malloc(size);
      if (!pixels) throw new Error("Not enough memory to render the page");
      const bitmap = module._FPDFBitmap_CreateEx(width, height, BGRA, pixels, width * 4);
      try {
        module._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        module._FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS);
        return { data: module.HEAPU8.slice(pixels, pixels + size) };
      } finally {
        module._FPDFBitmap_Destroy(bitmap);
        module.wasmExports.free(pixels);
      }
    });
  }

  function text(module: Module, key: string, index: number) {
    return withPage(module, key, index, (page) =>
      withTextPage(module, page, (textPage) => {
        const count = module._FPDFText_CountChars(textPage);
        if (count <= 0) return { text: "" };
        const buffer = module.wasmExports.malloc((count + 1) * 2);
        try {
          const length = module._FPDFText_GetText(textPage, 0, count, buffer);
          return { text: length > 0 ? utf16.decode(module.HEAPU8.subarray(buffer, buffer + (length - 1) * 2)) : "" };
        } finally {
          module.wasmExports.free(buffer);
        }
      }),
    );
  }

  // PDFium merges a range's characters into one rectangle per line, in PDF user space with the
  // origin at the bottom left. Boxes are normalized to the page with a top-left origin.
  function boxes(module: Module, key: string, index: number, ranges: [number, number][]) {
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    return withPage(module, key, index, (page) => {
      const width = module._FPDF_GetPageWidth(page);
      const height = module._FPDF_GetPageHeight(page);
      if (!(width > 0 && height > 0)) return { boxes: ranges.map(() => []) };
      return withTextPage(module, page, (textPage) => {
        const rect = module.wasmExports.malloc(32);
        try {
          return {
            boxes: ranges.map(([start, count]) => {
              const found: SearchBox[] = [];
              const rects = module._FPDFText_CountRects(textPage, start, count);
              for (let i = 0; i < rects; i++) {
                if (!module._FPDFText_GetRect(textPage, i, rect, rect + 8, rect + 16, rect + 24)) continue;
                const [left, top, right, bottom] = new Float64Array(module.HEAPU8.buffer, rect, 4);
                found.push({
                  x: clamp01(left! / width),
                  y: clamp01(1 - top! / height),
                  width: clamp01((right! - left!) / width),
                  height: clamp01((top! - bottom!) / height),
                });
              }
              return found;
            }),
          };
        } finally {
          module.wasmExports.free(rect);
        }
      });
    });
  }

  function size(module: Module, key: string, index: number) {
    return withPage(module, key, index, (page) => ({ width: module._FPDF_GetPageWidth(page), height: module._FPDF_GetPageHeight(page) }));
  }

  function run(module: Module, request: PdfiumRequest): { value?: unknown; failure?: PdfiumFailure } {
    switch (request.op) {
      case "open":
        return open(module, request.key, request.bytes, request.password);
      case "close":
        return { value: close(module, request.key) };
      case "size":
        return { value: size(module, request.key, request.index) };
      case "render":
        return { value: render(module, request.key, request.index, request.width, request.height) };
      case "text":
        return { value: text(module, request.key, request.index) };
      case "boxes":
        return { value: boxes(module, request.key, request.index, request.ranges) };
    }
  }

  port.on("message", async ({ id, request }: { id: number; request: PdfiumRequest }) => {
    let response: PdfiumResponse;
    try {
      const { value, failure } = run(await ready, request);
      response = failure ? { id, ok: false, failure } : { id, ok: true, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A module that failed to load, aborted or trapped is unusable; the host replaces this worker.
      const fatal = error instanceof wasm.RuntimeError || /^Aborted\(/.test(message) || !(await ready.then(() => true, () => false));
      const failure: PdfiumFailure = error instanceof Missing ? { kind: "missing" } : fatal ? { kind: "fatal", message } : { kind: "error", message };
      response = { id, ok: false, failure };
    }
    const data = response.ok && request.op === "render" ? (response.value as PdfiumResults["render"]).data : undefined;
    port.postMessage(response, data ? [data.buffer as ArrayBuffer] : []);
  });
}
