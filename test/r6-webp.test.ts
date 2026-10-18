import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as pluginRoot from "@getpaseo/plugin";
import * as pluginServer from "@getpaseo/plugin/server";
import * as zod from "zod";
import { listRecent, openDocument, renderPage } from "../server/documents";
import { errorCode } from "../shared/errors";
import { alphaRampPng, pngToRgba8 } from "./fixtures/generators.ts";
import { FIXTURES, decodePng, timed, workspace, workspaceWithFixtures } from "./helpers";
import { compileLikePaseo, evaluateBundle } from "./paseo-compile";

const photo = readFileSync(join(FIXTURES, "photo.png"));

function meanAbsoluteError(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
}

function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function vp8x(width: number, height: number, flags = 0): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return chunk("VP8X", data);
}

function vp8l(width: number, height: number): Buffer {
  const data = Buffer.alloc(64);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return chunk("VP8L", data);
}

function vp8(width: number, height: number): Buffer {
  const data = Buffer.alloc(64);
  data.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return chunk("VP8 ", data);
}

async function rendered(root: string, path: string) {
  const page = await renderPage({ root, path }, { index: 0 });
  if (page.kind !== "image-decoded") throw new Error(`expected a decoded image, got ${page.kind}`);
  expect(page.image.mimeType).toBe("image/png");
  return decodePng(page.image.data);
}

const failure = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);

describe("R6: WebP renders as a decoded image", () => {
  it("renders a lossy WebP matching the source pixels", async () => {
    const reference = pngToRgba8(photo);
    const root = workspaceWithFixtures("photo-lossy.webp");
    expect(await openDocument({ root, path: "photo-lossy.webp" })).toMatchObject({
      kind: "image-decoded",
      width: reference.width,
      height: reference.height,
    });
    const png = await rendered(root, "photo-lossy.webp");
    expect(png).toMatchObject({ width: reference.width, height: reference.height });
    expect(meanAbsoluteError(png.data, reference.data)).toBeLessThan(8);
  });

  it("renders a lossless WebP with alpha exactly", async () => {
    const reference = pngToRgba8(alphaRampPng(photo));
    const root = workspaceWithFixtures("alpha-lossless.webp");
    const png = await rendered(root, "alpha-lossless.webp");
    expect(png.data[3]).toBe(0);
    expect(png.data[(reference.width - 1) * 4 + 3]).toBe(255);
    expect(Buffer.compare(png.data, reference.data)).toBe(0);
  });

  it("renders the first frame of an animated WebP", async () => {
    const root = workspaceWithFixtures("animated.webp");
    expect(await openDocument({ root, path: "animated.webp" })).toMatchObject({ width: 64, height: 48 });
    const png = await rendered(root, "animated.webp");
    const [r, g, b] = png.data;
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });

  it("lists WebP files among recent documents", async () => {
    const root = workspaceWithFixtures("photo-lossy.webp");
    expect((await listRecent(root, {})).entries.map((entry) => entry.path)).toEqual(["photo-lossy.webp"]);
  });

  const bombs: [string, Buffer][] = [
    ["a canvas past the pixel cap", riff(vp8x(10_000, 10_000), vp8l(16, 16))],
    ["a small canvas hiding a huge lossless bitstream", riff(vp8x(16, 16), vp8l(16_000, 16_000))],
    ["a huge lossy bitstream", riff(vp8(16_000, 16_000))],
    ["an animation whose first frame is huge", riff(vp8x(16, 16, 0x02), chunk("ANIM", Buffer.alloc(6)), chunk("ANMF", Buffer.concat([Buffer.alloc(16), vp8l(16_000, 16_000)])))],
  ];
  for (const [name, bytes] of bombs) {
    it(`rejects ${name} before decoding`, async () => {
      const root = workspace({ "bomb.webp": bytes });
      const { value, ms } = await timed(() => failure(() => renderPage({ root, path: "bomb.webp" }, { index: 0 })));
      expect(errorCode(value)).toBe("too_large");
      expect(ms).toBeLessThan(1000);
    });
  }

  it("renders through a server bundle compiled and evaluated like Paseo", async () => {
    const bundle = await compileLikePaseo("server");
    const outside = createRequire(join(tmpdir(), "outside-plugin.cjs"));
    const host: Record<string, unknown> = { "@getpaseo/plugin": pluginRoot, "@getpaseo/plugin/server": pluginServer, zod };
    const contribute = evaluateBundle<(server: unknown) => () => void>(bundle, (name) => host[name] ?? outside(name));
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    contribute({ registerSettings: () => ({ read: async () => ({ status: "ready", revision: "", values: { turnCards: true } }), subscribe: () => () => {} }), on: () => () => {}, handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler) } as never);
    const root = workspaceWithFixtures("alpha-lossless.webp", "animated.webp");
    const paseo = {
      workspaces: {
        list: async () => ({
          entries: [{ id: "ws-1", workspaceDirectory: root, projectRootPath: root }],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        }),
      },
    };
    for (const path of ["alpha-lossless.webp", "animated.webp"]) {
      const page = (await handlers.get("doc.page")!({ workspaceId: "ws-1", path, index: 0 }, { paseo })) as {
        kind: string;
        image: { data: string };
      };
      expect(page.kind).toBe("image-decoded");
      expect(decodePng(page.image.data).width).toBeGreaterThan(0);
    }
  }, 60_000);
});
