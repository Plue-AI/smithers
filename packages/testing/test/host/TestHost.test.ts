import { describe, expect, it } from "@effect/vitest"
import { isJjError, Jj } from "@smthrs/jj"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as ProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import { Clock, Effect, FileSystem, Random, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as TestHost from "../../src/TestHost.ts"

const decoder = new TextDecoder()

describe("TestHost memory filesystem", () => {
  it.effect("collapses `.`, `..`, and trailing slashes onto one key", () =>
    Effect.gen(function*() {
      const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/a/b/c.txt": "seed" }))

      const reads = yield* (
        Effect.all([
          fs.readFile("/a/b/c.txt"),
          fs.readFile("/a/./b/c.txt"),
          fs.readFile("/a/x/../b/c.txt"),
          fs.readFile("//a//b//c.txt")
        ])
      )

      expect(reads.map((bytes) => decoder.decode(bytes))).toEqual(["seed", "seed", "seed", "seed"])
    }))

  it.effect("creates parent directories for a seeded file so its directory is listable", () =>
    Effect.gen(function*() {
      const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/deep/nest/file.txt": "x" }))

      const listing = yield* (Effect.all([fs.readDirectory("/"), fs.readDirectory("/deep")]))

      expect(listing).toEqual([["deep"], ["nest"]])
    }))

  it.effect("refuses a non-recursive mkdir with a missing parent without creating entries", () =>
    Effect.gen(function*() {
      const fs = BrowserFileSystem.make(TestHost.makeMemoryFs())

      const result = yield* (
        Effect.gen(function*() {
          const failure = yield* Effect.flip(fs.makeDirectory("/one/two"))
          const listedRoot = yield* fs.readDirectory("/")
          const missingParent = yield* Effect.flip(fs.stat("/one"))
          const missingChild = yield* Effect.flip(fs.stat("/one/two"))
          return { failure, listedRoot, missingParent, missingChild }
        })
      )

      expect(result.failure).toMatchObject({ reason: { _tag: "NotFound", method: "makeDirectory" } })
      expect(result.listedRoot).toEqual([])
      expect(result.missingChild).toMatchObject({ reason: { _tag: "NotFound", method: "stat" } })
      expect(result.missingParent).toMatchObject({ reason: { _tag: "NotFound", method: "stat" } })
    }))

  it.effect("refuses to open or read a directory as a file", () =>
    Effect.gen(function*() {
      const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/dir/f.txt": "x" }))

      const errors = yield* (
        Effect.all([
          Effect.flip(fs.readFile("/dir")),
          Effect.flip(Stream.runCollect(fs.stream("/dir")))
        ])
      )

      expect(errors.map((error) => error.reason._tag)).toEqual(["NotFound", "NotFound"])
    }))

  it.effect("reads past the end of a file as zero bytes instead of throwing", () =>
    Effect.gen(function*() {
      const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/f.txt": "ab" }))

      const chunks = yield* (Stream.runCollect(fs.stream("/f.txt", { offset: 99 })))

      expect(Array.from(chunks)).toEqual([])
    }))
})

describe("TestHost scripted commands", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner>,
    commands?: Readonly<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>
  ) => Effect.provide(effect, TestHost.layer(commands === undefined ? {} : { commands }))

  const outcome = (command: ChildProcess.Command) =>
    Effect.flatMap(ChildProcessSpawner, (spawner) =>
      Effect.all({
        stdout: spawner.string(command),
        stderr: Stream.mkString(spawner.streamString(command, { includeStderr: true })),
        exitCode: spawner.exitCode(command)
      }))

  it.effect("reports an unlisted command the way a shell reports a missing binary", () =>
    Effect.gen(function*() {
      const result = yield* run(outcome(ChildProcess.make("curl", ["https://example.com"])))

      expect(result).toEqual({
        stdout: "",
        stderr: "command not found: curl https://example.com\n",
        exitCode: 127
      })
    }))

  for (const command of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    it.effect(`reports unlisted ${command} as a missing binary with an empty command table`, () =>
      Effect.gen(function*() {
        const result = yield* run(outcome(ChildProcess.make(command)), {})

        expect(result).toEqual({ stdout: "", stderr: `command not found: ${command}\n`, exitCode: 127 })
      }))

    it.effect(`runs explicitly declared ${command}`, () =>
      Effect.gen(function*() {
        const result = yield* run(outcome(ChildProcess.make(command)), { [command]: { stdout: "declared" } })

        expect(result).toEqual({ stdout: "declared", stderr: "declared", exitCode: 0 })
      }))
  }

  it.effect("defaults every unscripted field of a declared command", () =>
    Effect.gen(function*() {
      const result = yield* run(outcome(ChildProcess.make("noop")), { noop: {} })

      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
    }))

  it.effect("emits stdout and stderr as one chunk each and omits empty ones", () =>
    Effect.gen(function*() {
      const collect = (name: string) =>
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          Effect.scoped(
            Effect.gen(function*() {
              const handle = yield* spawner.spawn(ChildProcess.make(name))
              const chunks = <E>(stream: Stream.Stream<Uint8Array, E>) =>
                Effect.map(Stream.runCollect(stream), (values) => Array.from(values, (v) => decoder.decode(v)))
              return { stdout: yield* chunks(handle.stdout), stderr: yield* chunks(handle.stderr) }
            })
          ))

      const [both, onlyErr, silent] = yield* run(
        Effect.all([collect("both"), collect("only-err"), collect("silent")]),
        {
          both: { stdout: "out", stderr: "err", exitCode: 1 },
          "only-err": { stderr: "bad" },
          silent: {}
        }
      )

      expect(both).toEqual({ stdout: ["out"], stderr: ["err"] })
      expect(onlyErr).toEqual({ stdout: [], stderr: ["bad"] })
      expect(silent).toEqual({ stdout: [], stderr: [] })
    }))
})

describe("TestHost determinism", () => {
  it.effect("restores seeded files on every build of the same layer", () =>
    Effect.gen(function*() {
      const host = TestHost.layer({ files: { "/seed.txt": "initial" } })
      const readThenWrite = Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const contents = yield* fs.readFileString("/seed.txt")
        yield* fs.writeFileString("/seed.txt", "changed")
        return contents
      })

      expect(yield* Effect.provide(readThenWrite, host)).toBe("initial")
      expect(yield* Effect.provide(readThenWrite, host)).toBe("initial")
    }))

  it.effect("produces the same random sequence for the same seed and a different one otherwise", () =>
    Effect.gen(function*() {
      const draw = Effect.gen(function*() {
        const random = yield* Random.Random
        return [random.nextDoubleUnsafe(), random.nextDoubleUnsafe(), random.nextIntUnsafe()]
      })

      const host = TestHost.layer({ seed: 7 })
      const first = yield* (Effect.provide(draw, host))
      const second = yield* (Effect.provide(draw, host))
      const other = yield* (Effect.provide(draw, TestHost.layer({ seed: 8 })))

      expect(first).toEqual(second)
      expect(first).not.toEqual(other)
      for (const value of first.slice(0, 2)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThan(1)
      }
      expect(Number.isInteger(first[2])).toBe(true)
    }))

  it.effect("holds the clock still until a test advances it", () =>
    Effect.gen(function*() {
      const observed = yield* (
        Effect.gen(function*() {
          const before = yield* Clock.currentTimeMillis
          yield* TestClock.adjust("5 seconds")
          const after = yield* Clock.currentTimeMillis
          return { before, after }
        }).pipe(Effect.provide(TestHost.TestHost))
      )

      expect(observed.before).toBe(0)
      expect(observed.after).toBe(5_000)
    }))

  it.effect("starts the zero-config bundle with an empty filesystem and no scripted commands", () =>
    Effect.gen(function*() {
      const state = yield* (
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner
          return {
            root: yield* fs.readDirectory("/"),
            exit: yield* spawner.exitCode(ChildProcess.make("ls"))
          }
        }).pipe(Effect.provide(TestHost.TestHost))
      )

      expect(state).toEqual({ root: [], exit: 127 })
    }))
})

describe("TestHost unsupported services", () => {
  it.effect("fails every jj method with `not_installed` and the command it would have run", () =>
    Effect.gen(function*() {
      const errors = yield* (
        Effect.gen(function*() {
          const jj = yield* Jj
          return yield* Effect.all([
            Effect.flip(jj.snapshot("msg")),
            Effect.flip(jj.restore("abc")),
            Effect.flip(jj.diff("a", "b")),
            Effect.flip(jj.workspaceAdd("lane", "/tmp/lane")),
            Effect.flip(jj.workspaceForget("lane")),
            Effect.flip(jj.status())
          ])
        }).pipe(Effect.provide(TestHost.TestHost))
      )

      const jjErrors = errors.map((error) => {
        if (!isJjError(error)) throw new Error("the test host's jj layer only fails with JjError")
        return error
      })
      // The browser refusal names the requested repository operation.
      expect(jjErrors.map((error) => error.command)).toEqual([
        "jj snapshot",
        "jj restore",
        "jj diff",
        "jj workspace add",
        "jj workspace forget",
        "jj status"
      ])
      expect(new Set(jjErrors.map((error) => error.code))).toEqual(new Set(["not_installed"]))
    }))

  it.effect("fails HTTP requests through the noop client", () =>
    Effect.gen(function*() {
      const client = HttpClient.makeNoop()

      const error = yield* (Effect.flip(client.get("https://example.com")))

      expect(error.reason._tag).toBe("TransportError")
    }))
})

describe("TestHost memory filesystem edges", () => {
  it("refuses to list a file as a directory", async () => {
    const memory = TestHost.makeMemoryFs({ "/dir/f.txt": "x" })

    await expect(memory.readdir("/dir/f.txt")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(memory.readdir("/dir")).resolves.toEqual(["f.txt"])
  })

  it("reports files and directories as such, and never as symbolic links", async () => {
    const memory = TestHost.makeMemoryFs({ "/dir/f.txt": "abc" })

    const file = await memory.stat("/dir/f.txt")
    const directory = await memory.stat("/dir")

    expect([file.isFile(), file.isDirectory(), file.isSymbolicLink()]).toEqual([true, false, false])
    expect([directory.isFile(), directory.isDirectory(), directory.isSymbolicLink()]).toEqual([false, true, false])
  })

  it("lists a nested path under its immediate parent name only once", async () => {
    const memory = TestHost.makeMemoryFs({ "/a/b/c.txt": "x", "/a/b/d.txt": "y", "/a/top.txt": "z" })

    expect(await memory.readdir("/a")).toEqual(["b", "top.txt"])
  })
})

describe("TestHost scripted interpreter latency", () => {
  /**
   * `delayMs` is the bundle's one concession to real time: a scripted command
   * can take a while, so a test can interleave work with a slow command or put
   * an `Effect.timeout` around one. Nothing else in the bundle moves without a
   * `TestClock.adjust`, so the knob is worth pinning.
   */
  it("holds a scripted command open for its declared delay", async () => {
    const bash = TestHost.makeStubBash({ slow: { stdout: "late", delayMs: 5 } })

    const started = performance.now()
    const result = await bash.exec("slow")

    expect(result).toEqual({ stdout: "late", stderr: "", exitCode: 0 })
    expect(performance.now() - started).toBeGreaterThanOrEqual(4)
  })

  it("rejects a pending command immediately when its signal is already aborted", async () => {
    const bash = TestHost.makeStubBash({ pending: { pending: true } })
    const controller = new AbortController()
    controller.abort(new Error("scope already closed"))

    await expect(bash.exec("pending", { signal: controller.signal })).rejects.toThrow("scope already closed")
  })
})

it.effect("deterministic host explicitly opts out of operating-system confinement", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const confinement = yield* ProcessConfinement.ProcessConfinement
      const command = ChildProcess.make("scripted")
      expect(confinement).toBe(ProcessConfinement.makeNoop)
      expect(
        yield* confinement.confine(command, {
          workspaceRoot: "/workspace",
          reads: [],
          writes: [],
          readOnly: [],
          network: "none"
        })
      ).toBe(command)
    }).pipe(Effect.provide(TestHost.layer()))
  ))
