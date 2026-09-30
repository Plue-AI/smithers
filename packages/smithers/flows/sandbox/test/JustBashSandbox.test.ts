import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { env as hostEnv } from "node:process"
import * as JustBashSandbox from "../src/JustBashSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { untouchable } from "./helpers/untouchable.ts"

const encoder = new TextEncoder()

// Real directories and real shells; the resolved root keeps macOS's symlinked
// temp tree from making `pwd` disagree with a session workdir.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-just-bash-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const services = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const local = yield* ChildProcessSpawner
  return { fs, local }
}).pipe(Effect.provide(platform))

// -----------------------------------------------------------------------------
// just-bash as a fake: a real `sh` behind the interpreter's own exec contract.
// -----------------------------------------------------------------------------

/**
 * The result shape just-bash 3.2.0 resolves from `exec` (`dist/types.d.ts`,
 * `interface BashExecResult`): the captured output text, the exit code, and
 * the final environment of the run. The provider slice reads the first three
 * fields; returning the vendor's whole required shape keeps the fake
 * assignable to `JustBashLike` exactly the way the real `Bash` class is.
 */
interface BashExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly env: Record<string, string>
}

interface ExecCall {
  readonly commandLine: string
  readonly options: JustBashSandbox.JustBashExecOptions
}

/** One byte per character, the latin1 byte buffer `stdinKind: "bytes"` names. */
const bytesOfLatin1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index) & 0xff
  }
  return bytes
}

const definedHostEnv = (): Record<string, string> => {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}

// The fake honors just-bash's documented `ExecOptions` semantics with a real
// `sh` run against the same real tree the injected `FileSystem` operates on,
// so "the interpreter and the filesystem are mounted on the same tree" is
// literally true here: `cwd` is this one call's working directory; `env` is
// merged into the interpreter's current environment (the host's, for a real
// shell); `stdin` with `stdinKind: "bytes"` is a latin1 byte buffer forwarded
// verbatim, `"text"` (the default) is UTF-8 encoded, and absent stdin is
// empty. A script table mirroring the provider's command lines would prove
// nothing; this reproduces the interpreter the provider has to drive.
const justBash = () => {
  const calls: Array<ExecCall> = []
  const exec = (commandLine: string, options: JustBashSandbox.JustBashExecOptions = {}): Promise<BashExecResult> =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      calls.push({ commandLine, options })
      const { local } = yield* services
      const stdin = options.stdin === undefined
        ? new Uint8Array()
        : options.stdinKind === "bytes"
        ? bytesOfLatin1(options.stdin)
        : encoder.encode(options.stdin)
      const child = yield* local.spawn(ChildProcess.make("sh", ["-c", commandLine], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        stdin: Stream.make(stdin)
      }))
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode
        ],
        { concurrency: "unbounded" }
      )
      return { stdout, stderr, exitCode, env: { ...definedHostEnv(), ...options.env } }
    })))
  return { bash: { exec } satisfies JustBashSandbox.JustBashLike, calls }
}

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.flatMap(session.spawn(command, options), (process) =>
      Effect.map(
        Effect.all([
          Stream.mkString(Stream.decodeText(process.stdout)),
          Stream.mkString(Stream.decodeText(process.stderr)),
          process.exitCode
        ]),
        ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })
      ))
  )

// The suite runs every command through a real `sh`; a loaded machine still fits this.
const budget = 60_000

describe("JustBashSandbox", () => {
  it("refuses every resource limit at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (
      const [field, limits] of [
        ["cpus", { cpus: 1 }],
        ["memoryMib", { memoryMib: 512 }],
        ["timeoutSecs", { timeoutSecs: 60 }]
      ] as const
    ) {
      expect(() => JustBashSandbox.make({ bash: deps.value, fs: deps.value, limits }))
        .toThrow(`just-bash-sandbox: cannot enforce limits.${field}`)
    }
    expect(() => JustBashSandbox.make({ bash: deps.value, fs: deps.value, limits: {} })).not.toThrow()
    expect(deps.touched).toEqual([])
  })

  it("refuses every network restriction and accepts \"open\" at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (const network of ["none", { allow: ["example.com"] }] as const) {
      expect(() => JustBashSandbox.make({ bash: deps.value, fs: deps.value, network }))
        .toThrow("just-bash-sandbox: cannot enforce a network policy; omit `network`")
    }
    expect(() => JustBashSandbox.make({ bash: deps.value, fs: deps.value, network: "open" })).not.toThrow()
    expect(deps.touched).toEqual([])
  })

  it.effect("serializes concurrent commands across sessions", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const events: Array<{ command: string; phase: string; time: number }> = []
      const bash: JustBashSandbox.JustBashLike = {
        exec: async (command) => {
          events.push({ command, phase: "enter", time: performance.now() })
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          events.push({ command, phase: "exit", time: performance.now() })
          return { stdout: command, stderr: "", exitCode: 0 }
        }
      }
      const provider = JustBashSandbox.make({ bash, fs, root })
      yield* Effect.scoped(Effect.gen(function*() {
        const one = yield* provider.acquire("serialized-one")
        const two = yield* provider.acquire("serialized-two")
        const results = yield* Effect.all([output(one, "one"), output(two, "two")], { concurrency: 2 })
        expect(results.map((result) => result.stdout)).toEqual(["one", "two"])
        expect(events.map(({ command, phase }) => `${command}:${phase}`)).toEqual([
          "one:enter",
          "one:exit",
          "two:enter",
          "two:exit"
        ])
        expect(events[2]!.time).toBeGreaterThanOrEqual(events[1]!.time)
      }))
    }))

  it.effect("times out callers while retaining the permit until exec settles", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const entered = yield* Deferred.make<void>()
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const calls: Array<string> = []
      const bash: JustBashSandbox.JustBashLike = {
        exec: async (command) => {
          calls.push(command)
          if (command === "held") {
            Deferred.doneUnsafe(entered, Effect.void)
            await pending
          }
          return { stdout: command, stderr: "", exitCode: 0 }
        }
      }
      const provider = JustBashSandbox.make({ bash, fs, root })
      yield* Effect.scoped(Effect.gen(function*() {
        const one = yield* provider.acquire("timeout-one")
        const two = yield* provider.acquire("timeout-two")
        yield* Effect.gen(function*() {
          const running = yield* output(one, "held").pipe(
            Effect.timeout("100 millis"),
            Effect.flip,
            Effect.forkChild
          )
          yield* Deferred.await(entered)
          yield* TestClock.adjust("100 millis")
          expect(running.pollUnsafe()).toBeDefined()
          expect((yield* Fiber.join(running))._tag).toBe("TimeoutError")

          const queued = yield* output(two, "cancelled-in-queue").pipe(
            Effect.timeout("100 millis"),
            Effect.flip,
            Effect.forkChild
          )
          yield* TestClock.adjust("100 millis")
          expect(queued.pollUnsafe()).toBeDefined()
          expect((yield* Fiber.join(queued))._tag).toBe("TimeoutError")
          expect(calls).toEqual(["held"])

          finish()
          expect((yield* output(two, "after")).stdout).toBe("after")
          expect(calls).toEqual(["held", "after"])
        }).pipe(Effect.ensuring(Effect.sync(() => finish())))
      }))
    }))

  it.effect("documents string output as UTF-8 text and directs binary output to file transfer", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const provider = JustBashSandbox.make({
        bash: { exec: async () => ({ stdout: "\u00ff", stderr: "\ufffd", exitCode: 0 }) },
        fs,
        root
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* provider.acquire("text-output")
        const process = yield* session.spawn("binary-output", {})
        expect(Array.from(yield* Stream.runCollect(process.stdout))).toEqual([new Uint8Array([195, 191])])
        expect(Array.from(yield* Stream.runCollect(process.stderr))).toEqual([new Uint8Array([239, 191, 189])])
      }))
      const limits = readFileSync(new URL("../docs/limits.md", import.meta.url), "utf8")
      const textProviders = limits.slice(limits.indexOf("It is not"), limits.indexOf("whose vendor"))
      expect(textProviders).toContain("`JustBashSandbox`")
      expect(limits).toContain("reads that back with `readFile`")
    }))

  it.effect("refuses guest inherited environment deletion before interpreter execution", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const fake = justBash()
      const provider = JustBashSandbox.make({ bash: fake.bash, fs, root })
      yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* provider.acquire("env-delete")
        expect((yield* output(session, `printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
        const calls = fake.calls.length
        const error = yield* Effect.flip(session.spawn("touch must-not-run", { env: { HOME: undefined } }))
        expect(error).toBeInstanceOf(ProviderError)
        expect(error.code).toBe("spawn_error")
        expect(error.message).toContain("environment deletion is unsupported")
        expect(fake.calls).toHaveLength(calls)
      }))
    }), 60_000)

  it.effect(
    "passes SandboxConformance with a real interpreter and filesystem on one real tree",
    () =>
      Effect.gen(function*() {
        const { fs } = yield* services
        const fake = justBash()
        const provider = JustBashSandbox.make({ bash: fake.bash, fs, root: `${root}/conformance` })
        const violations = yield* SandboxConformance.check(provider, { provides: { ping: true } })
        expect(violations).toEqual([])
        // The interpreter was driven the way the contract says: in the session
        // workspace, with the caller's environment, with bytes-typed stdin.
        expect(
          fake.calls.some((call) => call.options.cwd?.startsWith(`${root}/conformance/sandbox-conformance-`) === true)
        ).toBe(true)
        expect(
          fake.calls.find((call) => call.options.env?.SANDBOX_CONFORMANCE !== undefined)?.options.env
        ).toEqual({ SANDBOX_CONFORMANCE: "delivered" })
        expect(fake.calls.some((call) => call.options.stdin !== undefined)).toBe(true)
        expect(fake.calls.every((call) => call.options.stdin === undefined || call.options.stdinKind === "bytes"))
          .toBe(true)
      }),
    budget
  )

  it.effect(
    "shares one real tree between the interpreter and the filesystem",
    () =>
      Effect.gen(function*() {
        const { fs } = yield* services
        const fake = justBash()
        const provider = JustBashSandbox.make({ bash: fake.bash, fs, root: `${root}/virtual///` })
        let released = ""
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* provider.acquire("shared/tree")
            released = session.workdir
            expect(session.remoteId).toBe(session.workdir)
            expect(session.workdir.startsWith(`${root}/virtual/shared-tree-`)).toBe(true)
            // Documented divergences that still hold: no signal delivery, so
            // sessions omit `kill` and the conformance run above skipped its
            // kill-and-survivor check instead of reporting a violation.
            expect(session.kill).toBeUndefined()
            yield* session.ping!

            // Bytes written through the session are the bytes a real process
            // measures and reads back.
            const binary = new Uint8Array([0, 1, 2, 255, 254])
            yield* session.writeFile(`${session.workdir}/deep/data.bin`, binary)
            expect(Array.from(yield* session.readFile(`${session.workdir}/deep/data.bin`))).toEqual([...binary])
            expect((yield* output(session, "wc -c < deep/data.bin")).stdout.trim()).toBe("5")
            expect((yield* output(session, "base64 < deep/data.bin")).stdout).toBe("AAEC//4=\n")

            // Standard input takes the latin1 bytes path in 8 KiB slices: a
            // payload past the slice boundary with every byte value in it
            // survives to the file a real `cat` writes.
            const payload = new Uint8Array(3 * 8192 + 7)
            for (let index = 0; index < payload.length; index++) payload[index] = (index * 31) & 0xff
            expect((yield* output(session, "cat > fed.bin", { stdin: payload })).exitCode).toBe(0)
            expect(Array.from(yield* session.readFile(`${session.workdir}/fed.bin`))).toEqual([...payload])
            const fed = fake.calls.at(-1)!
            expect(fed.options.stdinKind).toBe("bytes")
            expect(fed.options.stdin?.length).toBe(payload.length)

            // A relative cwd roots at the workdir, dot forms included; an
            // absolute one passes through.
            yield* output(session, "mkdir -p sub")
            expect((yield* output(session, "pwd", { cwd: "sub" })).stdout).toBe(`${session.workdir}/sub\n`)
            expect((yield* output(session, "pwd", { cwd: "./sub" })).stdout).toBe(`${session.workdir}/sub\n`)
            expect((yield* output(session, "pwd", { cwd: "." })).stdout).toBe(`${session.workdir}\n`)
            expect((yield* output(session, "pwd", { cwd: "" })).stdout).toBe(`${session.workdir}\n`)
            expect((yield* output(session, "pwd", { cwd: root })).stdout).toBe(`${root}\n`)
            // The interpreter receives the path `Sandbox.fileSystem` would name
            // for `.//sub`, not `<workdir>//sub`.
            yield* output(session, "true", { cwd: ".//sub" })
            expect(fake.calls.at(-1)!.options.cwd).toBe(`${session.workdir}/sub`)

            // Defined environment entries are merged for this one call.
            const env = yield* output(session, `printf '%s' "$KEPT"`, {
              env: { KEPT: "yes" }
            })
            expect(env.stdout).toBe("yes")
            const refusal = yield* Effect.flip(output(session, "true", { env: { DROPPED: undefined } }))
            expect(refusal.code).toBe("spawn_error")
            expect(fake.calls.at(-1)?.options.env).toEqual({ KEPT: "yes" })

            // Run-to-completion replay, the other documented divergence: both
            // streams and the status arrive after the fact, empty output as an
            // empty stream and captured output as a single chunk.
            const replayed = yield* output(session, "printf 'out'; printf 'err' >&2; exit 4")
            expect(replayed).toEqual({ stdout: "out", stderr: "err", exitCode: 4 })
            yield* Effect.scoped(Effect.gen(function*() {
              const done = yield* session.spawn("exit 0", {})
              expect(yield* Stream.runCollect(done.stdout)).toEqual([])
              expect(yield* Stream.runCollect(done.stderr)).toEqual([])
              expect(yield* done.exitCode).toBe(0)
            }))
            yield* Effect.scoped(Effect.gen(function*() {
              const chunked = yield* session.spawn("printf 'one chunk'", {})
              expect(yield* Stream.runCollect(chunked.stdout)).toHaveLength(1)
            }))

            // The native overrides serve the derived filesystem surface with
            // the workdir rooting rule, against the same tree the probes see.
            const native = Sandbox.fileSystem(session)
            const probed = Sandbox.fileSystem({ ...session, files: undefined })
            yield* native.makeDirectory("notes")
            yield* native.writeFileString("notes/agenda.txt", "prepared", { flag: "wx", mode: 0o640 })
            expect((yield* native.stat("notes/agenda.txt")).mode & 0o7777).toBe(0o640)
            yield* fs.symlink(`${session.workdir}/notes/agenda.txt`, `${session.workdir}/notes/link.txt`)
            expect(yield* native.exists("notes/agenda.txt")).toBe(true)
            expect(yield* native.exists("missing")).toBe(false)
            expect(yield* probed.exists("notes/agenda.txt")).toBe(true)
            expect((yield* native.stat("./notes/agenda.txt")).size).toBe(8n)
            expect((yield* native.stat(".")).type).toBe("Directory")
            expect((yield* native.readDirectory("notes")).sort()).toEqual(["agenda.txt", "link.txt"])
            expect(yield* native.readLink("notes/link.txt")).toBe(`${session.workdir}/notes/agenda.txt`)
            expect(yield* native.realPath("notes/link.txt")).toBe(`${session.workdir}/notes/agenda.txt`)
            yield* native.makeDirectory("build/out", { recursive: true })
            yield* native.rename("notes/agenda.txt", "build/out/agenda.txt")
            expect((yield* output(session, "cat build/out/agenda.txt")).stdout).toBe("prepared")
            yield* native.remove("notes", { recursive: true, force: true })
            expect(yield* native.exists("notes")).toBe(false)

            // An absolute write outside the workspace still lands on the one
            // shared tree: a workspace boundary, not a security boundary.
            yield* session.writeFile(`${root}/virtual/top-level.bin`, new Uint8Array([9]))
            expect(yield* fs.exists(`${root}/virtual/top-level.bin`)).toBe(true)
          })
        )
        // Releasing the scope removed the workspace.
        expect(yield* fs.exists(released)).toBe(false)
      }),
    budget
  )

  it.effect("keeps colliding keys in separate workspaces and tears both down", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const fake = justBash()
      const provider = JustBashSandbox.make({ bash: fake.bash, fs, root: `${root}/lanes` })
      const workdirs = yield* Effect.scoped(
        Effect.gen(function*() {
          const one = yield* provider.acquire("lane/one")
          const other = yield* provider.acquire("lane-one")
          expect(one.workdir).not.toBe(other.workdir)
          yield* one.writeFile(`${one.workdir}/proof.txt`, encoder.encode("one"))
          expect(yield* fs.exists(`${other.workdir}/proof.txt`)).toBe(false)
          return [one.workdir, other.workdir]
        })
      )
      for (const workdir of workdirs) {
        expect(yield* fs.exists(workdir)).toBe(false)
      }
    }), budget)

  it.effect("maps interpreter and filesystem failures into the provider vocabulary", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const fake = justBash()

      // A root that sits under a plain file cannot host a workspace.
      yield* fs.writeFile(`${root}/plug`, new Uint8Array())
      const blocked = JustBashSandbox.make({ bash: fake.bash, fs, root: `${root}/plug` })
      expect((yield* Effect.flip(Effect.scoped(blocked.acquire("unavailable")))).code).toBe("unavailable")

      const provider = JustBashSandbox.make({ bash: fake.bash, fs, root: `${root}/failures` })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("failures")
          expect((yield* Effect.flip(session.readFile(`${session.workdir}/absent`))).code).toBe("not_found")
          yield* fs.writeFile(`${session.workdir}/sealed.bin`, new Uint8Array([1]))
          chmodSync(`${session.workdir}/sealed.bin`, 0)
          expect((yield* Effect.flip(session.readFile(`${session.workdir}/sealed.bin`))).code).toBe("unknown")
          yield* fs.writeFile(`${session.workdir}/blocker`, new Uint8Array())
          expect(
            (yield* Effect.flip(session.writeFile(`${session.workdir}/blocker/child`, new Uint8Array([1])))).code
          ).toBe("unknown")
        })
      )

      // A rejecting interpreter is a spawn error, not a defect.
      const broken: JustBashSandbox.JustBashLike = {
        exec: () => Promise.reject(new Error("interpreter crashed"))
      }
      const crashed = JustBashSandbox.make({ bash: broken, fs, root: `${root}/broken` })
      const spawnFailure = yield* Effect.flip(
        Effect.scoped(
          Effect.flatMap(crashed.acquire("broken-bash"), (session) =>
            Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
        )
      )
      expect(spawnFailure.code).toBe("spawn_error")

      // The root option defaults to the virtual `/workspace`. Proving that
      // must not create `/workspace` on this real host, so the one acquire
      // against the default runs on a filesystem that only records the
      // directory it is asked to make; nothing spawns through it.
      const made: Array<string> = []
      const recording = FileSystem.makeNoop({
        makeDirectory: (path) =>
          Effect.sync(() => {
            made.push(path)
          }),
        remove: () =>
          Effect.void
      })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* JustBashSandbox.make({ bash: fake.bash, fs: recording }).acquire("defaults")
          expect(session.workdir.startsWith("/workspace/defaults-")).toBe(true)
          expect(made).toEqual([session.workdir])
        })
      )
    }), budget)
})
