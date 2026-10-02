import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import { expect, it, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Log from "../src/log.ts"
import * as Watch from "../src/watch.ts"

const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } = fs

const flow = (label = "Review") =>
  `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("review", {
  description: "${label}", capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.String, body: () => Node.succeed("ready")
})
`

const fixture = (existing = true, initialSource?: string, prepare?: (cwd: string) => void) => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-watch-"))
  const directory = join(cwd, "flows")
  const source = join(directory, "review", "flow.ts")
  if (existing) mkdirSync(directory)
  if (initialSource !== undefined) {
    mkdirSync(join(directory, "review"))
    writeFileSync(source, initialSource)
  }
  prepare?.(cwd)
  let refreshes = 0
  let receive: (() => void) | undefined
  const watcher = Watch.flows(cwd, () => {
    refreshes++
    receive?.()
  }, 100)
  return {
    cwd,
    directory,
    source,
    count: () => refreshes,
    dispose: watcher.dispose,
    // The deadline can only reject: receipt requires the watcher's callback.
    next: () =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          receive = undefined
          reject(new Error("No filesystem change receipt within 5 seconds"))
        }, 5000)
        receive = () => {
          clearTimeout(deadline)
          receive = undefined
          resolve()
        }
      }),
    // Observe more than two reconciliation intervals without synthesizing a receipt.
    quiet: () =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          receive = undefined
          resolve()
        }, 2200)
        receive = () => {
          clearTimeout(deadline)
          receive = undefined
          reject(new Error("Unexpected filesystem refresh"))
        }
      }),
    close: () => {
      watcher.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  }
}

const discover = (cwd: string) =>
  Effect.runPromise(
    Effect.flatMap(Discovery.Discovery, (discovery) =>
      discovery.scan({ source: "project", root: join(cwd, "flows"), naming: "path", optionalRoot: true })).pipe(
        Effect.provide(Discovery.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))))
      )
  )

it("receives an immediate existing-file edit even when its size and mtime are preserved", async () => {
  const test = fixture(true, flow())
  try {
    const before = statSync(test.source)
    const edited = test.next()
    writeFileSync(test.source, flow("Rewind"))
    utimesSync(test.source, before.atime, before.mtime)
    expect(statSync(test.source).size).toBe(before.size)
    expect(readFileSync(test.source, "utf8")).toBe(flow("Rewind"))
    await edited
    expect(test.count()).toBe(1)
    await test.quiet()
  } finally {
    test.close()
  }
}, 10000)

for (const existing of [true, false]) {
  it(`receives immediate subtree creation with flows/ ${existing ? "already present" : "created later"}`, async () => {
    const test = fixture(existing)
    try {
      const created = test.next()
      mkdirSync(join(test.directory, "review"), { recursive: true })
      writeFileSync(test.source, flow())
      expect(readFileSync(test.source, "utf8")).toBe(flow())
      await created
      expect(test.count()).toBe(1)
      const edited = test.next()
      writeFileSync(test.source, flow("Recheck"))
      expect(readFileSync(test.source, "utf8")).toBe(flow("Recheck"))
      await edited
      expect(test.count()).toBe(2)
      await test.quiet()
    } finally {
      test.close()
    }
  }, 15000)
}

it("does not refresh an unchanged tree or edits inside ignored directories", async () => {
  const test = fixture()
  try {
    await test.quiet()
    expect(test.count()).toBe(0)
    const linked = test.next()
    mkdirSync(join(test.directory, "node_modules", "dependency"), { recursive: true })
    mkdirSync(join(test.directory, ".git"))
    await linked
    const quiet = test.quiet()
    writeFileSync(join(test.directory, "node_modules", "dependency", "flow.ts"), flow())
    writeFileSync(join(test.directory, ".git", "index"), "changed")
    await quiet
    expect(test.count()).toBe(1)
  } finally {
    test.close()
  }
}, 10000)

for (const linked of ["root", "directory", "file"] as const) {
  it(`refreshes a discovered linked ${linked}, follows target edits, and observes replacement`, async () => {
    const outside = mkdtempSync(join(tmpdir(), "tui-watch-linked-"))
    const replacement = mkdtempSync(join(tmpdir(), "tui-watch-replacement-"))
    const target = join(outside, "review", "flow.ts")
    for (const directory of [outside, replacement]) mkdirSync(join(directory, "review"))
    writeFileSync(target, flow())
    writeFileSync(join(replacement, "review", "flow.ts"), flow("Replacement"))
    // Canonical discovery bounds this directory cycle by physical identity.
    if (linked !== "file") symlinkSync(outside, join(outside, "review", "back"))
    let link!: string
    const test = fixture(linked !== "root", undefined, (cwd) => {
      link = linked === "root" ? join(cwd, "flows") : join(cwd, "flows", "review")
      if (linked === "file") {
        mkdirSync(link)
        link = join(link, "flow.ts")
      }
      symlinkSync(linked === "root" ? outside : linked === "directory" ? join(outside, "review") : target, link)
    })
    try {
      const initial = await discover(test.cwd)
      expect(initial.entries.map((entry) => [entry.name, entry.description])).toEqual([["review", "Review"]])
      if (linked !== "file") expect(initial.warnings.some((warning) => warning.code === "symlink_cycle")).toBe(true)
      const edited = test.next()
      writeFileSync(target, flow("Recheck"))
      expect(readFileSync(test.source, "utf8")).toBe(flow("Recheck"))
      await edited
      expect((await discover(test.cwd)).entries[0]?.description).toBe("Recheck")
      const replaced = test.next()
      fs.unlinkSync(link)
      symlinkSync(
        linked === "root" ? replacement : linked === "directory" ?
          join(replacement, "review") :
          join(replacement, "review", "flow.ts"),
        link
      )
      await replaced
      expect((await discover(test.cwd)).entries[0]?.description).toBe("Replacement")
      expect(test.count()).toBe(2)
      await test.quiet()
    } finally {
      test.close()
      rmSync(outside, { recursive: true, force: true })
      rmSync(replacement, { recursive: true, force: true })
    }
  }, 15000)
}

it("matches canonical discovery's depth boundary instead of scanning unreachable descendants", async () => {
  let included!: string
  let excluded!: string
  const test = fixture(true, undefined, (cwd) => {
    const segments = Array.from({ length: 32 }, (_, index) => `level${index}`)
    const directory = join(cwd, "flows", ...segments)
    mkdirSync(join(directory, "deeper"), { recursive: true })
    included = join(directory, "flow.ts")
    excluded = join(directory, "deeper", "flow.ts")
    writeFileSync(included, flow("Included").replace("Flow.make(\"review\"", `Flow.make("${segments.join("/")}"`))
    writeFileSync(excluded, flow("Excluded"))
  })
  try {
    const catalog = await discover(test.cwd)
    expect(catalog.entries.map((entry) => entry.description)).toEqual(["Included"])
    expect(catalog.warnings.some((warning) => warning.code === "max_depth_exceeded")).toBe(true)
    const quiet = test.quiet()
    writeFileSync(excluded, flow("Still excluded"))
    await quiet
    expect(test.count()).toBe(0)
    const changed = test.next()
    writeFileSync(included, readFileSync(included, "utf8").replace("Included", "Updated"))
    await changed
    expect((await discover(test.cwd)).entries[0]?.description).toBe("Updated")
    expect(test.count()).toBe(1)
  } finally {
    test.close()
  }
}, 10000)

it("keeps discovered siblings fresh beside unresolved link cycles and recovers repaired links", async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "tui-watch-loop-"))
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = diagnostics
  const notices: Array<string> = []
  const unsubscribe = Log.subscribe((message) => notices.push(message))
  const test = fixture(true, flow(), (cwd) => {
    symlinkSync("loop", join(cwd, "flows", "loop"))
    mkdirSync(join(cwd, "flows", "broken"))
    symlinkSync("flow.ts", join(cwd, "flows", "broken", "flow.ts"))
  })
  try {
    const catalog = await discover(test.cwd)
    expect(catalog.entries.map((entry) => [entry.name, entry.description])).toEqual([["review", "Review"]])
    expect(catalog.warnings.some((warning) => warning.code === "unreadable")).toBe(true)
    const edited = test.next()
    writeFileSync(test.source, flow("Recheck"))
    await edited
    expect((await discover(test.cwd)).entries[0]?.description).toBe("Recheck")
    await test.quiet()
    expect(notices).toContain("The watched source could not be read. Details: /conversation")
    expect(notices.every((message) => !message.includes("ELOOP") && !message.includes(test.cwd))).toBe(true)
    const records = readFileSync(Log.path(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(records.filter((record) => record.tag === "flow.watch.entry")).toHaveLength(2)
    expect(readFileSync(Log.path(), "utf8")).toContain("ELOOP")
    const repaired = test.next()
    fs.unlinkSync(join(test.directory, "loop"))
    fs.unlinkSync(join(test.directory, "broken", "flow.ts"))
    writeFileSync(
      join(test.directory, "broken", "flow.ts"),
      flow("Recovered").replace("Flow.make(\"review\"", "Flow.make(\"broken\"")
    )
    await repaired
    expect((await discover(test.cwd)).entries.map((entry) => [entry.name, entry.description])).toEqual([
      ["broken", "Recovered"],
      ["review", "Recheck"]
    ])
    expect(test.count()).toBe(2)
  } finally {
    unsubscribe()
    test.close()
    rmSync(diagnostics, { recursive: true, force: true })
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
  }
}, 15000)

it.skipIf(process.getuid?.() === 0)(
  "keeps discovered siblings fresh beside unreadable child targets and directories",
  async () => {
    const outside = mkdtempSync(join(tmpdir(), "tui-watch-denied-"))
    const locked = join(outside, "locked")
    mkdirSync(locked)
    writeFileSync(join(locked, "flow.ts"), flow("Blocked").replace("Flow.make(\"review\"", "Flow.make(\"blocked\""))
    const previous = process.env.SMITHERS_TUI_SESSION_DIR
    process.env.SMITHERS_TUI_SESSION_DIR = join(outside, "diagnostics")
    const notices: Array<string> = []
    const unsubscribe = Log.subscribe((message) => notices.push(message))
    const test = fixture(true, flow(), (cwd) => {
      mkdirSync(join(cwd, "flows", "blocked"))
      symlinkSync(join(locked, "flow.ts"), join(cwd, "flows", "blocked", "flow.ts"))
      mkdirSync(join(cwd, "flows", "denied"))
      writeFileSync(
        join(cwd, "flows", "denied", "flow.ts"),
        flow("Denied").replace("Flow.make(\"review\"", "Flow.make(\"denied\"")
      )
      chmodSync(locked, 0)
      chmodSync(join(cwd, "flows", "denied"), 0)
    })
    try {
      const catalog = await discover(test.cwd)
      expect(catalog.entries.map((entry) => [entry.name, entry.description])).toEqual([["review", "Review"]])
      expect(catalog.warnings.some((warning) => warning.code === "unreadable")).toBe(true)
      const edited = test.next()
      writeFileSync(test.source, flow("Recheck"))
      await edited
      expect((await discover(test.cwd)).entries[0]?.description).toBe("Recheck")
      await test.quiet()
      expect(notices.filter((message) => message === "The watched source could not be read. Details: /conversation"))
        .toHaveLength(1)
      expect(notices.every((message) => !message.includes("EACCES") && !message.includes(test.cwd))).toBe(true)
      const records = readFileSync(Log.path(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      expect(records.filter((record) => record.tag === "flow.watch.entry")).toHaveLength(2)
      expect(readFileSync(Log.path(), "utf8")).toContain("EACCES")
      const recovered = test.next()
      chmodSync(locked, 0o755)
      chmodSync(join(test.directory, "denied"), 0o755)
      await recovered
      expect((await discover(test.cwd)).entries.map((entry) => entry.description)).toEqual([
        "Blocked",
        "Denied",
        "Recheck"
      ])
      expect(test.count()).toBe(2)
    } finally {
      unsubscribe()
      chmodSync(locked, 0o755)
      chmodSync(join(test.directory, "denied"), 0o755)
      test.close()
      rmSync(outside, { recursive: true, force: true })
      if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
      else process.env.SMITHERS_TUI_SESSION_DIR = previous
    }
  },
  15000
)

it("coalesces a synchronous burst and stops pending and later refreshes on dispose", async () => {
  const test = fixture()
  try {
    const burst = test.next()
    mkdirSync(join(test.directory, "review"))
    for (let n = 0; n < 20; n++) writeFileSync(test.source, flow(`Review ${n}`))
    expect(readFileSync(test.source, "utf8")).toBe(flow("Review 19"))
    await burst
    await test.quiet()
    expect(test.count()).toBe(1)
    const quiet = test.quiet()
    writeFileSync(test.source, flow("Cancelled"))
    test.dispose()
    test.dispose()
    writeFileSync(test.source, flow("After dispose"))
    await quiet
    expect(test.count()).toBe(1)
  } finally {
    test.close()
  }
}, 10000)

it("receives deletion, recreation, and changes in the replacement tree", async () => {
  const test = fixture()
  try {
    const removed = test.next()
    rmSync(test.directory, { recursive: true })
    await removed
    const recreated = test.next()
    mkdirSync(join(test.directory, "review"), { recursive: true })
    writeFileSync(test.source, flow())
    await recreated
    const edited = test.next()
    writeFileSync(test.source, flow("Replacement"))
    await edited
    expect(test.count()).toBe(3)
    await test.quiet()
  } finally {
    test.close()
  }
}, 20000)

it("keeps one scan in flight and stops reading or refreshing after disposal", async () => {
  const original = fsPromises.lstat
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("No reconciliation scan within 5 seconds")), 5000)
    entered = () => {
      clearTimeout(deadline)
      resolve()
    }
  })
  let reads = 0
  // Delay a real metadata read to exercise cancellation/order deterministically.
  const stats = spyOn(fsPromises, "lstat").mockImplementation(
    (async (...args: unknown[]) => {
      reads++
      entered()
      await blocked
      return Reflect.apply(original, fsPromises, args)
    }) as typeof fsPromises.lstat
  )
  let test: ReturnType<typeof fixture> | undefined
  try {
    test = fixture()
    await started
    await test.quiet()
    expect(reads).toBe(1)
    mkdirSync(join(test.directory, "review"))
    writeFileSync(test.source, flow())
    test.dispose()
    release()
    await test.quiet()
    expect(reads).toBe(1)
    expect(test.count()).toBe(0)
  } finally {
    release()
    test?.close()
    stats.mockRestore()
  }
}, 10000)

it.skipIf(process.getuid?.() === 0)(
  "reports unreadable flow trees safely, retains diagnostics, and recovers",
  async () => {
    const test = fixture()
    const previous = process.env.SMITHERS_TUI_SESSION_DIR
    process.env.SMITHERS_TUI_SESSION_DIR = join(test.cwd, "diagnostics")
    let unsubscribe = () => {}
    try {
      const reported = new Promise<string>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("No filesystem failure notice within 5 seconds")), 5000)
        unsubscribe = Log.subscribe((message) => {
          clearTimeout(deadline)
          resolve(message)
        })
      })
      chmodSync(test.directory, 0)
      const message = await reported
      expect(message).toBe("Flows could not be listed; the last list stays. Details: /conversation")
      expect(message).not.toContain(test.cwd)
      expect(message).not.toContain("EACCES")
      await test.quiet()
      expect(test.count()).toBe(0)
      const records = readFileSync(Log.path(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      const diagnostics = records.filter((record) => record.tag === "failure.flow")
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0].detail).toContain("EACCES")
      expect(diagnostics[0].detail).toContain(test.directory)
      const recovered = test.next()
      chmodSync(test.directory, 0o755)
      mkdirSync(join(test.directory, "review"))
      writeFileSync(test.source, flow())
      await recovered
      expect(test.count()).toBe(1)
    } finally {
      unsubscribe()
      chmodSync(test.directory, 0o755)
      test.close()
      if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
      else process.env.SMITHERS_TUI_SESSION_DIR = previous
    }
  },
  15000
)

it("retries a failed native install and ignores errors from a replaced handle", async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "tui-watch-install-"))
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = diagnostics
  const original = fs.watch
  const installed: Array<fs.FSWatcher> = []
  let attempts = 0
  // Portable real filesystems cannot deliberately produce EIO or a late native
  // error. Only delivery/install is controlled; successful watches remain real.
  const watches = spyOn(fs, "watch").mockImplementation(
    ((path: fs.PathLike, ...args: unknown[]) => {
      if (typeof path === "string" && path.endsWith("/flows")) {
        attempts++
        if (attempts === 1) throw Object.assign(new Error("private install diagnostic"), { code: "EIO" })
        const watcher = Reflect.apply(original, fs, [path, ...args]) as fs.FSWatcher
        installed.push(watcher)
        return watcher
      }
      return Reflect.apply(original, fs, [path, ...args]) as fs.FSWatcher
    }) as typeof fs.watch
  )
  let test: ReturnType<typeof fixture> | undefined
  let closes: { readonly mockRestore: () => void } | undefined
  try {
    test = fixture()
    const created = test.next()
    mkdirSync(join(test.directory, "review"))
    writeFileSync(test.source, flow())
    await created
    expect(attempts).toBe(2)
    expect(installed).toHaveLength(1)
    const staleError = installed[0]!.listeners("error")[0]!
    const removed = test.next()
    rmSync(test.directory, { recursive: true })
    await removed
    const recreated = test.next()
    mkdirSync(join(test.directory, "review"), { recursive: true })
    writeFileSync(test.source, flow("Replacement"))
    await recreated
    expect(installed).toHaveLength(2)
    closes = spyOn(installed[1]!, "close")
    staleError(Object.assign(new Error("private stale diagnostic"), { code: "EIO" }))
    expect(closes).not.toHaveBeenCalled()
    await test.quiet()
    expect(test.count()).toBe(3)
    const log = readFileSync(Log.path(), "utf8")
    expect(log).toContain("private install diagnostic")
    expect(log).not.toContain("private stale diagnostic")
  } finally {
    closes?.mockRestore()
    test?.close()
    watches.mockRestore()
    rmSync(diagnostics, { recursive: true, force: true })
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
  }
}, 20000)
