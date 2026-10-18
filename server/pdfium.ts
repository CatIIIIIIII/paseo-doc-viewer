import { Worker } from "node:worker_threads";
import { PDFiumLibrary, PDFiumModule } from "@hyzyla/pdfium/inline";
import { ERROR_MESSAGES } from "../shared/errors";
import { RPC_DEADLINE_MS } from "../shared/limits";
import { pdfiumWorkerMain, type PdfiumRequest, type PdfiumResponse, type PdfiumResults, type PdfiumWorkerInit, type WasmApi } from "./pdfium-worker";

// PDFium runs in one worker thread. Rendering is synchronous WASM, so on the plugin's own thread a
// heavy page froze every other request, and an Emscripten abort poisoned the module for every PDF.
// Here a call that runs past its deadline or is aborted terminates the worker, an abort replaces
// it, and the next call starts a fresh one. Calls run one at a time, in order.

export const PDFIUM_IDLE_MS = 60_000;

export class PdfiumLoadError extends Error {
  constructor(
    readonly code: number,
    readonly certificate: boolean,
  ) {
    super(`PDFium could not load the document (error ${code})`);
  }
}

export interface PdfiumCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Job {
  id: number;
  request: PdfiumRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve(value: unknown): void;
  reject(error: Error): void;
  abort(): void;
  timer?: ReturnType<typeof setTimeout>;
}

const queue: Job[] = [];
let running: Job | undefined;
let worker: Worker | undefined;
let init: Promise<PdfiumWorkerInit> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
let generation = 0;
const stats = { spawns: 0, opens: 0 };

// @hyzyla/pdfium/inline decodes its embedded wasm inside init() and hands the bytes to initBase;
// capture them there instead of instantiating PDFium on this thread.
async function wasmBytes(): Promise<ArrayBuffer> {
  const library = PDFiumLibrary as unknown as { initBase?: (options: { wasmBinary: ArrayBuffer }) => Promise<unknown> };
  library.initBase = async (options) => options.wasmBinary;
  try {
    return (await PDFiumLibrary.init({ disableBase64Warning: true })) as unknown as ArrayBuffer;
  } finally {
    delete library.initBase;
  }
}

// The worker evaluates the Emscripten factory from its source. Bundled, it refers to two
// module-level helpers whose names the bundler may suffix; unbundled it reads import.meta.
async function workerInit(): Promise<PdfiumWorkerInit> {
  const glue = PDFiumModule.toString().replace(/\bimport\.meta\b/g, "import_meta");
  const importMeta = /\b(import_meta\d*)\.url\b/.exec(glue)?.[1];
  const defineProperty = /\b(_defineProperty\d*)\(this,/.exec(glue)?.[1];
  if (!importMeta || !defineProperty) throw new Error("Unexpected PDFium build: the worker cannot load it");
  const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;
  return { glue, importMeta, defineProperty, wasm: await wasm.compile(await wasmBytes()) };
}

const WORKER_SOURCE = `const { parentPort, workerData } = require("node:worker_threads");\n(${pdfiumWorkerMain.toString()})(parentPort, workerData);`;

async function ensureWorker(): Promise<Worker> {
  const data = await (init ??= workerInit().catch((error: unknown) => {
    init = undefined;
    throw error;
  }));
  if (worker) return worker;
  const created = new Worker(WORKER_SOURCE, { eval: true, workerData: data, execArgv: [] });
  created.unref();
  created.on("message", (response: PdfiumResponse) => respond(created, response));
  created.on("error", (error) => crashed(created, error));
  created.on("exit", (code) => crashed(created, new Error(`PDFium worker exited with code ${code}`)));
  worker = created;
  stats.spawns++;
  return created;
}

function settle(job: Job, outcome: { value: unknown } | { error: Error }): void {
  clearTimeout(job.timer);
  job.signal?.removeEventListener("abort", job.abort);
  if ("error" in outcome) job.reject(outcome.error);
  else job.resolve(outcome.value);
}

// Ends the current worker and fails everything in flight: the documents it held are gone.
function restart(culprit?: { job: Job; error: Error }): void {
  const dead = worker;
  worker = undefined;
  generation++;
  void dead?.terminate();
  const victims = [...(running ? [running] : []), ...queue.splice(0)];
  running = undefined;
  for (const job of victims) settle(job, { error: job === culprit?.job ? culprit.error : new Error(ERROR_MESSAGES.busy()) });
}

function crashed(source: Worker, error: Error): void {
  if (source !== worker) return;
  console.error("[doc-viewer] PDFium worker stopped:", error.message);
  restart(running && { job: running, error: new Error(ERROR_MESSAGES.pdfRenderFailed()) });
}

function respond(source: Worker, response: PdfiumResponse): void {
  const job = running;
  if (source !== worker || !job || job.id !== response.id) return;
  if (!response.ok && response.failure.kind === "fatal") {
    console.error("[doc-viewer] PDFium aborted; starting a new worker:", response.failure.message);
    restart({ job, error: new Error(ERROR_MESSAGES.pdfRenderFailed()) });
    return void pump();
  }
  running = undefined;
  if (response.ok) settle(job, { value: response.value });
  else if (response.failure.kind === "load") settle(job, { error: new PdfiumLoadError(response.failure.code, response.failure.certificate) });
  else if (response.failure.kind === "missing") settle(job, { error: new Error(ERROR_MESSAGES.busy()) });
  else {
    console.error("[doc-viewer] PDFium:", response.failure.message);
    settle(job, { error: new Error(ERROR_MESSAGES.pdfDamaged()) });
  }
  void pump();
}

function idle(): void {
  clearTimeout(idleTimer);
  if (running || queue.length > 0) return;
  idleTimer = setTimeout(() => {
    if (running || queue.length > 0 || !worker) return;
    void worker.terminate();
    worker = undefined;
    generation++;
  }, PDFIUM_IDLE_MS);
  // React Native's global typings shadow Node's, so setTimeout is typed as returning a number.
  (idleTimer as unknown as NodeJS.Timeout).unref();
}

async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return idle();
  running = job;
  clearTimeout(idleTimer);
  let target: Worker;
  try {
    target = await ensureWorker();
  } catch (error) {
    console.error("[doc-viewer] PDFium worker could not start:", error);
    running = undefined;
    settle(job, { error: new Error(ERROR_MESSAGES.pdfRenderFailed()) });
    return pump();
  }
  if (running !== job) return;
  job.timer = setTimeout(() => restart({ job, error: new Error(ERROR_MESSAGES.tooSlow()) }), job.timeoutMs);
  if (job.request.op === "open") stats.opens++;
  const transfer = job.request.op === "open" ? [job.request.bytes.buffer as ArrayBuffer] : [];
  target.postMessage({ id: job.id, request: job.request }, transfer);
}

function abandon(job: Job): void {
  if (job === running) {
    restart({ job, error: new Error(ERROR_MESSAGES.tooSlow()) });
    void pump();
    return;
  }
  const at = queue.indexOf(job);
  if (at >= 0) queue.splice(at, 1);
  settle(job, { error: new Error(ERROR_MESSAGES.tooSlow()) });
}

export function pdfium<Op extends PdfiumRequest["op"]>(
  request: Extract<PdfiumRequest, { op: Op }>,
  { signal, timeoutMs = RPC_DEADLINE_MS }: PdfiumCallOptions = {},
): Promise<PdfiumResults[Op]> {
  return new Promise<PdfiumResults[Op]>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(ERROR_MESSAGES.tooSlow()));
    // The bytes are transferred to the worker, so they must own their whole buffer.
    const plain: PdfiumRequest = request;
    const owned: PdfiumRequest =
      plain.op === "open" && (plain.bytes.byteOffset !== 0 || plain.bytes.byteLength !== plain.bytes.buffer.byteLength)
        ? { ...plain, bytes: new Uint8Array(plain.bytes) }
        : plain;
    const job: Job = {
      id: nextId++,
      request: owned,
      timeoutMs,
      signal,
      resolve: resolve as (value: unknown) => void,
      reject,
      abort: () => abandon(job),
    };
    signal?.addEventListener("abort", job.abort, { once: true });
    queue.push(job);
    void pump();
  });
}

// Documents opened in an earlier generation are gone with the worker that held them.
export function pdfiumGeneration(): number {
  return generation;
}

export function pdfiumStats(): { spawns: number; opens: number; alive: boolean } {
  return { ...stats, alive: worker !== undefined };
}
