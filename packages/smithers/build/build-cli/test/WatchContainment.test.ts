import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const fixtureEntry = vi.hoisted(() => ({ manifest: "", watcher: undefined as import("node:fs").FSWatcher | undefined }))
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>()
  return {
    ...fs,
    watch: (root: string, options: object, listener: (event: string, file: string | null) => void) => {
      fixtureEntry.watcher = fs.watch(root, options, listener)
      return fixtureEntry.watcher
    }
  }
})
vi.mock("node:module", async (original) => {
  const module = await original<typeof import("node:module")>()
  return {
    ...module,
    createRequire: (url: string | URL) => {
      const require = module.createRequire(url)
      if (!String(url).endsWith("/Watch.ts")) return require
      const resolve = require.resolve
      require.resolve = Object.assign(
        (id: string, options?: Parameters<typeof resolve>[1]) =>
          id === "@smthrs/build-cli/package.json" ? fixtureEntry.manifest : resolve(id, options),
        { paths: resolve.paths }
      )
      return require
    }
  }
})
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import * as Watch from "../src/Watch.ts"

const roots: Array<string> = []
const pids: Array<number> = []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
    return false
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
  for (const root of roots.splice(0)) await Fs.rm(root, { recursive: true, force: true })
})

const fixture = async (body: string) => {
  const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "smithers-m2-watch-")))
  roots.push(root)
  fixtureEntry.manifest = join(root, "package.json")
  await Fs.writeFile(fixtureEntry.manifest, "{\"type\":\"module\"}")
  await Fs.mkdir(join(root, "src"))
  await Fs.writeFile(join(root, "src/main.js"), body)
  return root
}

// Adapted from /tmp/smithers-k4-watch-repro.mjs: the descendant ignores TERM
// and inherits no output pipes, so leader close cannot stand in for group death.
const resistantDescendant = `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", pid => {
  process.stdout.write(JSON.stringify({ leader: process.pid, descendant: pid }) + "\\n");
});
setInterval(() => {}, 1000);
`

describe.skipIf(process.platform === "win32")("watch process-group containment", () => {
  it.each(["change", "abort"])("surfaces cleanup failure after %s and starts no replacement", async (trigger) => {
    const root = await fixture("")
    const controller = new AbortController()
    const failure = new ContainedProcess.ProcessError("cleanup_failed", "fixture cleanup failed")
    const run = vi.spyOn(ContainedProcess, "runEffect").mockReturnValue(
      Effect.sync(() =>
        setImmediate(() => {
          if (trigger === "abort") controller.abort()
          else fixtureEntry.watcher!.emit("change", "change", "changed.txt")
        })
      ).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.die(failure)))
    )
    await expect(
      Watch.run({
        root,
        args: [],
        ignored: [],
        debounceMs: 1,
        once: false,
        signal: controller.signal,
        stdout: () => {},
        stderr: () => {}
      })
    ).rejects.toBe(failure)
    expect(run).toHaveBeenCalledOnce()
  })

  it("keeps a relevant change when ignored events arrive in the same turn", async () => {
    const root = await fixture("")
    const controller = new AbortController()
    let started = 0
    let cleaned = 0
    vi.spyOn(ContainedProcess, "runEffect").mockReturnValue(
      Effect.sync(() => {
        started++
        if (started === 1) {
          setImmediate(() => {
            fixtureEntry.watcher!.emit("change", "change", "changed.txt")
            fixtureEntry.watcher!.emit("change", "change", "node_modules/ignored.txt")
          })
        } else {
          expect(cleaned).toBe(1)
          controller.abort()
        }
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => {
          cleaned++
        }))
      )
    )
    expect(
      await Watch.run({
        root,
        args: [],
        ignored: [],
        debounceMs: 1,
        once: false,
        signal: controller.signal,
        stdout: () => {},
        stderr: () => {}
      })
    )
      .toEqual({ cycles: 2, exitCode: 1, stopped: true })
    expect(cleaned).toBe(2)
  })

  it("folds changes seen during a stale cycle's cleanup into one replacement", async () => {
    const root = await fixture("")
    const controller = new AbortController()
    let started = 0
    vi.spyOn(ContainedProcess, "runEffect").mockReturnValue(
      Effect.sync(() => {
        started++
        if (started === 1) setImmediate(() => fixtureEntry.watcher!.emit("change", "rename", "changed.txt"))
        else setTimeout(() => controller.abort(), 50)
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.suspend(() => {
          if (started !== 1) return Effect.void
          fixtureEntry.watcher!.emit("change", "change", "changed.txt")
          return Effect.sleep(50)
        }))
      )
    )
    expect(
      await Watch.run({
        root,
        args: [],
        ignored: [],
        debounceMs: 1,
        once: false,
        signal: controller.signal,
        stdout: () => {},
        stderr: () => {}
      })
    ).toEqual({ cycles: 2, exitCode: 1, stopped: true })
    expect(started).toBe(2)
  })

  it.each(["default", "ignores TERM", "exits zero"])(
    "awaits the resistant descendant before reporting cancellation (leader %s)",
    async (leader) => {
      const root = await fixture(
        resistantDescendant + (leader === "default" ? "" : leader === "ignores TERM"
          ? "\nprocess.on(\"SIGTERM\", () => {});"
          : "\nprocess.on(\"SIGTERM\", () => process.exit(0));")
      )
      const controller = new AbortController()
      let pending = ""
      let descendant = 0
      let leaderPid = 0
      let completed = false
      let errors = ""
      const deadline = setTimeout(() => controller.abort(), 15_000)
      try {
        const result = await Watch.run({
          root,
          args: [],
          ignored: [basename(root), "src", "package.json"],
          debounceMs: 20,
          once: false,
          signal: controller.signal,
          stdout: (text) => {
            pending += text
            if (!pending.includes("\n")) return
            const message = JSON.parse(pending)
            descendant = message.descendant
            leaderPid = message.leader
            pids.push(descendant, leaderPid)
            expect(alive(descendant)).toBe(true)
            controller.abort()
          },
          stderr: (text) => {
            errors += text
          },
          cycleCompleted: () => {
            expect(descendant, errors).toBeGreaterThan(1)
            expect(alive(descendant)).toBe(false)
            expect(alive(leaderPid)).toBe(false)
            expect(alive(-leaderPid)).toBe(false)
            completed = true
          }
        })
        expect(result).toEqual({ cycles: 1, exitCode: 1, stopped: true })
        expect(completed).toBe(true)
      } finally {
        clearTimeout(deadline)
      }
    }
  )

  it("contains a surviving descendant even when its leader succeeds naturally", async () => {
    const root = await fixture(resistantDescendant.replace(
      "process.stdout.write(JSON.stringify({ leader: process.pid, descendant: pid }) + \"\\n\");",
      "process.stdout.write(JSON.stringify({ leader: process.pid, descendant: pid }) + \"\\n\", () => process.exit(0));"
    ))
    let descendant = 0
    let pending = ""
    const result = await Watch.run({
      root,
      args: [],
      ignored: [],
      debounceMs: 20,
      once: true,
      stdout: (text) => {
        pending += text
        if (!pending.includes("\n")) return
        const message = JSON.parse(pending)
        descendant = message.descendant
        pids.push(descendant, message.leader)
      },
      stderr: () => {}
    })
    expect(result).toEqual({ cycles: 1, exitCode: 0, stopped: false })
    expect(descendant).toBeGreaterThan(1)
    expect(alive(descendant)).toBe(false)
  })

  it("waits for group cleanup before surfacing a watcher error", async () => {
    const root = await fixture(resistantDescendant)
    const failure = new Error("fixture watch failed")
    let descendant = 0
    let pending = ""
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 15_000)
    try {
      await expect(Watch.run({
        root,
        args: [],
        ignored: [basename(root), "src", "package.json"],
        debounceMs: 20,
        once: false,
        signal: controller.signal,
        stdout: (text) => {
          pending += text
          if (!pending.includes("\n")) return
          const message = JSON.parse(pending)
          descendant = message.descendant
          pids.push(descendant, message.leader)
          fixtureEntry.watcher!.emit("error", failure)
        },
        stderr: () => {}
      })).rejects.toBe(failure)
      expect(descendant).toBeGreaterThan(1)
      expect(alive(descendant)).toBe(false)
    } finally {
      clearTimeout(deadline)
    }
  })

  it("does not launch a replacement until the stale cycle's descendant is gone", async () => {
    const root = await fixture(resistantDescendant)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 25_000)
    let firstDescendant = 0
    let frames = 0
    let pending = ""
    let changed: Promise<void> | undefined
    try {
      const result = await Watch.run({
        root,
        args: [],
        ignored: [basename(root), "src", "package.json"],
        debounceMs: 20,
        once: false,
        signal: controller.signal,
        stdout: (text) => {
          pending += text
          if (!pending.includes("\n")) return
          const message = JSON.parse(pending)
          pending = ""
          pids.push(message.descendant, message.leader)
          frames += 1
          if (frames === 1) {
            firstDescendant = message.descendant
            changed = Fs.writeFile(join(root, "changed.txt"), "new input")
          } else {
            expect(alive(firstDescendant)).toBe(false)
            controller.abort()
          }
        },
        stderr: () => {}
      })
      await changed
      expect(frames).toBe(2)
      expect(result).toEqual({ cycles: 2, exitCode: 1, stopped: true })
      expect(pids.every((pid) => !alive(pid))).toBe(true)
    } finally {
      clearTimeout(deadline)
    }
  })
})
