import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../server/file-lock";
import { ERROR_MESSAGES } from "../shared/errors";
import { bundleProbe, pluginModule } from "./capped-child";
import { workspace } from "./helpers";

const hooks = vi.hoisted(() => ({
  rm: null as ((file: string) => void) | null,
  stat: null as ((file: string) => Promise<void>) | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      hooks.rm?.(String(args[0]));
      return actual.rm(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args);
      await hooks.stat?.(String(args[0]));
      return info;
    },
  };
});
afterEach(() => {
  hooks.rm = hooks.stat = null;
  vi.restoreAllMocks();
});

const ago = (ms: number) => new Date(Date.now() - ms);
const leave = (lock: string, mtime: Date) => {
  writeFileSync(lock, "");
  utimesSync(lock, mtime, mtime);
};
const busy = (file: string) => Object.assign(new Error(`EBUSY: resource busy, unlink '${file}'`), { code: "EBUSY" });

// A lock left by a writer that died is taken over once it is old. Waiters that all saw it old used to
// remove each other's fresh lock, so two writers held it at once (about one trial in two with ten
// processes), and a lock stamped in the future never counted as old.
describe("file lock", () => {
  it("holds the lock while the work runs and releases it after, whatever the work did", async () => {
    const lock = join(workspace(), "x.lock");
    expect(await withFileLock(lock, async () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
    await expect(
      withFileLock(lock, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a lock left by a process that died", async () => {
    const lock = join(workspace(), "x.lock");
    leave(lock, ago(20_000));
    expect(await withFileLock(lock, async () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });

  it("clears a takeover guard left by a process that died too", async () => {
    const lock = join(workspace(), "x.lock");
    leave(lock, ago(20_000));
    leave(`${lock}.takeover`, ago(20_000));
    expect(await withFileLock(lock, async () => "ran")).toBe("ran");
    expect([existsSync(lock), existsSync(`${lock}.takeover`)]).toEqual([false, false]);
  });

  it("takes over a lock stamped in the future, as when the clock was set back", async () => {
    const lock = join(workspace(), "x.lock");
    leave(lock, new Date(Date.now() + 3_600_000));
    expect(await withFileLock(lock, async () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });

  it("waits for a lock stamped a moment ahead, which a file system can do to a live one", async () => {
    const lock = join(workspace(), "x.lock");
    leave(lock, new Date(Date.now() + 500));
    let ran = false;
    const waiting = withFileLock(lock, async () => {
      ran = true;
    });
    await delay(100);
    expect(ran).toBe(false);
    rmSync(lock);
    await waiting;
    expect(ran).toBe(true);
  });

  it("gives up as busy while another holds the lock, and leaves the lock to its holder", async () => {
    const lock = join(workspace(), "x.lock");
    let skew = 0;
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + skew);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = withFileLock(lock, async () => {
      entered();
      await finished;
    });
    await inside;
    const waiting = expect(withFileLock(lock, async () => "never")).rejects.toThrow(ERROR_MESSAGES.busy());
    await delay(50);
    skew = 6_000;
    await waiting;
    expect(existsSync(lock)).toBe(true);
    finish();
    await held;
    expect(existsSync(lock)).toBe(false);
  });

  it("tries the release again when it fails", async () => {
    const lock = join(workspace(), "x.lock");
    let failures = 2;
    hooks.rm = (file) => {
      if (file === lock && failures-- > 0) throw busy(file);
    };
    expect(await withFileLock(lock, async () => "result")).toBe("result");
    expect(failures).toBe(-1);
    expect(existsSync(lock)).toBe(false);
  });

  it("does not let a release that keeps failing replace what the work returned or threw", async () => {
    const lock = join(workspace(), "x.lock");
    hooks.rm = (file) => {
      if (file === lock) throw busy(file);
    };
    expect(await withFileLock(lock, async () => "result")).toBe("result");
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    await expect(
      withFileLock(lock, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(existsSync(lock)).toBe(true);
  });

  it("lets one of two waiters that saw the same stale lock take it over, not both", async () => {
    const lock = join(workspace(), "x.lock");
    leave(lock, ago(20_000));
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => (entered = resolve));
    // The first waiter to read the lock's age sleeps on what it read until the other holds a lock of its own.
    let reads = 0;
    hooks.stat = async (file) => {
      if (file === lock && reads++ === 0) await holding;
    };
    let inside = 0;
    let overlapped = false;
    const hold = () =>
      withFileLock(lock, async () => {
        entered();
        if (++inside > 1) overlapped = true;
        await delay(50);
        inside--;
      });
    await Promise.all([hold(), hold()]);
    expect(overlapped).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it("serializes writers in one process, so no update is lost", async () => {
    const dir = workspace({ counter: "0" });
    const [lock, counter] = [join(dir, "x.lock"), join(dir, "counter")];
    let inside = 0;
    let overlapped = false;
    const writer = async () => {
      for (let round = 0; round < 3; round++) {
        await withFileLock(lock, async () => {
          if (++inside > 1) overlapped = true;
          const count = Number(readFileSync(counter, "utf8"));
          await delay(Math.random() * 3);
          writeFileSync(counter, String(count + 1));
          inside--;
        });
      }
    };
    await Promise.all(Array.from({ length: 10 }, writer));
    expect(overlapped).toBe(false);
    expect(readFileSync(counter, "utf8")).toBe("30");
  });

  it("keeps one holder at a time across processes that find a stale lock together", async () => {
    const worker = `
      import { readFileSync, rmSync, writeFileSync } from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { withFileLock } from ${pluginModule("server/file-lock.ts")};
      const [lock, counter, marker, startAt, rounds] = process.argv.slice(2);
      await delay(Math.max(0, Number(startAt) - Date.now()));
      let overlaps = 0;
      for (let round = 0; round < Number(rounds); round++) {
        await withFileLock(lock, async () => {
          try { writeFileSync(marker, "", { flag: "wx" }); } catch { overlaps++; }
          const count = Number(readFileSync(counter, "utf8"));
          await delay(Math.random() * 5);
          writeFileSync(counter, String(count + 1));
          rmSync(marker, { force: true });
        });
      }
      console.log(overlaps);`;
    const dir = workspace();
    const probe = await bundleProbe(worker, dir);
    const [lock, counter, marker] = ["x.lock", "counter", "marker"].map((name) => join(dir, name));
    const [writers, rounds] = [10, 2];
    for (let trial = 0; trial < 6; trial++) {
      writeFileSync(counter, "0");
      leave(lock, ago(20_000));
      const startAt = String(Date.now() + 400);
      const results = await Promise.all(
        Array.from({ length: writers }, () => promisify(execFile)(process.execPath, [probe, lock, counter, marker, startAt, String(rounds)])),
      );
      expect(results.map(({ stdout }) => Number(stdout))).toEqual(Array(writers).fill(0));
      expect(readFileSync(counter, "utf8")).toBe(String(writers * rounds));
    }
  }, 60_000);
});
