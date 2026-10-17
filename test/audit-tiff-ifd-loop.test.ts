import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT } from "./helpers";
import { selfReferentialTiff } from "./fixtures/hostile";

// Audit (post 0.4.0): opening a TIFF runs server/images.ts firstTiffPage() -> UTIF.decode, which
// follows the IFD chain with no cycle detection. A 26-byte TIFF whose IFD points at itself makes
// UTIF.decode allocate until the process aborts with "JavaScript heap out of memory" (reproduced
// standalone at --max-old-space-size=128). openDocument/thumbnail on such a .tiff crashes the
// forked plugin child, which the host never respawns, so the doc viewer dies for the whole session.
// Run in a capped child so the OOM does not take down the vitest worker.

function decodesWithoutCrash(base64: string): { code: number | null; signal: string | null } {
  const script = `const {createRequire}=require("node:module");const UTIF=createRequire(${JSON.stringify(PLUGIN_ROOT + "/x.js")})("utif2");UTIF.decode(Buffer.from(process.argv[1],"base64"));`;
  try {
    execFileSync(process.execPath, ["--max-old-space-size=128", "-e", script, base64], { timeout: 15_000, stdio: "ignore" });
    return { code: 0, signal: null };
  } catch (error) {
    const e = error as { status?: number | null; signal?: string | null };
    return { code: e.status ?? null, signal: e.signal ?? null };
  }
}

describe("audit: TIFF IFD cycle", () => {
  it.fails("decodes a self-referential TIFF without crashing the process", () => {
    const result = decodesWithoutCrash(selfReferentialTiff().toString("base64"));
    expect(result).toEqual({ code: 0, signal: null });
  }, 20_000);
});
