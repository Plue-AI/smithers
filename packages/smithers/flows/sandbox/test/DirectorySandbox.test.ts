import { describe, expect, it } from "@effect/vitest"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { Effect, Exit, FileSystem, Layer, Path, PlatformError, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as ProcessTable from "../../../../testing/src/ProcessTable.ts"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import type { RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { contain, platform, rawPlatform } from "./helpers/containedPlatform.ts"
import { untouchable } from "./helpers/untouchable.ts"

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

/** Whether the host still knows the pid: `kill -0`, so a zombie counts until it is reaped. */
const processIsAlive = (pid: number): boolean => {
  try {
    globalThis.process.kill(pid, 0)
    return true
  } catch (cause) {
    return !isErrno(cause, "ESRCH")
  }
}

/**
 * Whether the pid's work has ended. A killed orphan lingers as a zombie until
 * pid 1 reaps it, longer than any polite wait on a loaded machine, and a
 * zombie's work is over, so `Z` counts as ended while a live state is a real
 * survivor.
 */
const processHasEnded = (pid: number): boolean => {
  if (!processIsAlive(pid)) return true
  const state = ProcessTable.query({ pid, columns: ["stat"] }).trim()
  return state === "" || state.startsWith("Z")
}

/** Polls a host-visible condition in real time; the delay only spaces bounded retries. */
const waitFor = (condition: () => boolean, description: string, timeoutMs = 5_000): Effect.Effect<void> =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
  })

/** The process group a live pid leads or joined; `undefined` once it is gone. */
const groupOf = (pid: number): number | undefined => {
  const group = Number(ProcessTable.query({ pid, columns: ["pgid"], timeoutMs: 2000 }).trim())
  return Number.isInteger(group) && group > 0 ? group : undefined
}

const ownGroup = groupOf(globalThis.process.pid)

/**
 * The live host processes this test started: the given roots, their
 * descendants, and every member of a group one of them led. Ownership comes
 * from pids and groups the test recorded, never from a command line, so a
 * concurrent run's lookalike `sleep` is neither awaited nor killed. The
 * runner's own group is excluded in case the spawner shared it.
 */
const ownedProcesses = (
  roots: ReadonlyArray<number>,
  groups: ReadonlyArray<number>
): Array<{ readonly pid: number; readonly args: string }> => {
  const rows = ProcessTable.query({ columns: ["pid", "ppid", "pgid", "args"], timeoutMs: 2000 })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .flatMap((match) =>
      match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), args: match[4]! }]
    )
  const owned = new Set(roots.filter(Number.isInteger))
  const ownedGroups = new Set(groups.filter((group) => group !== ownGroup))
  for (const row of rows) if (ownedGroups.has(row.pgid)) owned.add(row.pid)
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid)
        grew = true
      }
    }
  }
  owned.delete(globalThis.process.pid)
  return rows.filter((row) => owned.has(row.pid) && !row.args.startsWith("ps "))
}

/** Force-ends only what {@link ownedProcesses} attributes to this test. */
const killOwned = (roots: ReadonlyArray<number>, groups: ReadonlyArray<number>): void => {
  for (const { pid } of ownedProcesses(roots, groups)) {
    try {
      globalThis.process.kill(pid, "SIGKILL")
    } catch {
      // Already gone, which is the point.
    }
  }
}

/**
 * Starts a host `sleep` with the same command line as a fixture but outside
 * the sandbox, standing in for a concurrent test run's process; the returned
 * effect checks it survived this test's cleanup and then ends it.
 */
const lookalike = (seconds: string) =>
  Effect.acquireRelease(
    Effect.sync(() => spawn("sleep", [seconds], { stdio: "ignore" })),
    (control) => Effect.sync(() => control.kill("SIGKILL"))
  ).pipe(Effect.map((control) => ({
    survived: Effect.sync(() => {
      expect(control.pid).toBeTypeOf("number")
      expect(processHasEnded(control.pid!), `cleanup ended the unrelated \`sleep ${seconds}\``).toBe(false)
    })
  })))

/**
 * The pids a kill fixture prints on its first lines: the wrapper the host
 * spawner owns first, then the descendant that must not survive it. A line the
 * fixture never printed reads back as `NaN`, which the caller asserts on
 * rather than handing to `kill`.
 */
const printedPids = (process: RemoteProcess, count: number): Effect.Effect<Array<number>, ProviderError> =>
  Stream.decodeText(process.stdout).pipe(
    Stream.splitLines,
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map(Number))
  )

const stdoutOf = (process: RemoteProcess): Effect.Effect<string, ProviderError> =>
  Stream.mkString(Stream.decodeText(process.stdout))

// Real directories and real processes; the resolved root keeps macOS's
// symlinked temp tree from making `pwd` disagree with the session workdir.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-directory-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const services = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return { fs, spawner }
}).pipe(Effect.provide(platform))

const provider = Effect.map(services, ({ fs, spawner }) => DirectorySandbox.make({ fs, spawner, root }))

// The suite spawns real `sleep` processes; a loaded machine still fits this.
const budget = 30_000

describe("DirectorySandbox", () => {
  it("refuses every resource limit at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (
      const [field, limits] of [
        ["cpus", { cpus: 1 }],
        ["memoryMib", { memoryMib: 512 }],
        ["timeoutSecs", { timeoutSecs: 60 }]
      ] as const
    ) {
      expect(() => DirectorySandbox.make({ fs: deps.value, spawner: deps.value, root: "/unused", limits }))
        .toThrow(`directory-sandbox: cannot enforce limits.${field}`)
    }
    expect(() => DirectorySandbox.make({ fs: deps.value, spawner: deps.value, root: "/unused", limits: {} })).not
      .toThrow()
    expect(deps.touched).toEqual([])
  })

  it("refuses every network policy at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (const network of ["none", { allow: ["example.com"] }] as const) {
      expect(() => DirectorySandbox.make({ fs: deps.value, spawner: deps.value, root: "/unused", network }))
        .toThrow("directory-sandbox: cannot enforce a network policy; omit `network`")
    }
    expect(deps.touched).toEqual([])
  })

  it.effect("refuses raw and deadline-only spawners before creating a workspace or starting a command", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      let created = 0
      let spawns = 0
      const raw = makeSpawner(() =>
        Effect.suspend(() => {
          spawns++
          return Effect.fail(PlatformError.badArgument({ module: "ChildProcess", method: "spawn" }))
        })
      )
      const deadlineOnly = yield* contain(raw)
      for (const spawner of [raw, deadlineOnly]) {
        const directory = DirectorySandbox.make({
          fs: {
            ...fs,
            makeDirectory: (...args) =>
              Effect.suspend(() => {
                created++
                return fs.makeDirectory(...args)
              })
          },
          spawner,
          root
        })
        const error = yield* Effect.scoped(Effect.flip(directory.acquire("uncontained")))
        expect(error).toMatchObject({ code: "unavailable" })
        expect(error.message).toContain("contained ChildProcessSpawner")
      }
      expect({ created, spawns }).toEqual({ created: 0, spawns: 0 })
    }))

  it.effect(
    "passes the sandbox conformance suite against real directories and processes",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const violations = yield* SandboxConformance.check(directory, {
          provides: { kill: true, ping: true }
        })
        expect(violations).toEqual([])
      }),
    budget
  )

  it.effect(
    "serves the whole probe dialect against a real tree when native overrides are stripped",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("probe-dialect")
            const { fs } = yield* services
            // Stripping the native overrides forces every derived operation
            // through the POSIX probes, against the same real directory.
            const probed = Sandbox.fileSystem({ ...session, files: undefined })
            const native = Sandbox.fileSystem(session)
            const file = `${session.workdir}/notes/agenda.txt`
            yield* session.writeFile(file, new TextEncoder().encode("prepared"))
            yield* fs.symlink(file, `${session.workdir}/notes/link.txt`)

            expect(yield* probed.exists(file)).toBe(true)
            expect(yield* probed.exists(`${session.workdir}/nowhere`)).toBe(false)
            const stat = yield* probed.stat(file)
            expect(stat.type).toBe("File")
            expect(stat.size).toBe(8n)
            expect((yield* probed.stat(`${session.workdir}/notes`)).type).toBe("Directory")
            expect(yield* probed.readDirectory(`${session.workdir}/notes`)).toEqual(["agenda.txt", "link.txt"])
            expect(yield* probed.readDirectory(session.workdir, { recursive: true })).toEqual([
              "notes",
              "notes/agenda.txt",
              "notes/link.txt"
            ])
            expect(yield* probed.readLink(`${session.workdir}/notes/link.txt`)).toBe(file)
            expect(yield* probed.realPath(`${session.workdir}/notes/link.txt`)).toBe(file)
            yield* probed.makeDirectory(`${session.workdir}/build/out`, { recursive: true })
            yield* probed.rename(file, `${session.workdir}/build/out/agenda.txt`)
            yield* probed.remove(`${session.workdir}/notes`, { recursive: true, force: true })
            expect(yield* probed.exists(`${session.workdir}/notes`)).toBe(false)
            expect(yield* native.readDirectory(`${session.workdir}/build/out`)).toEqual(["agenda.txt"])
            // Relative paths are the workspace's on both the probe and the
            // native surface, never the host process's cwd.
            yield* native.writeFileString("relative.txt", "rooted")
            expect(yield* probed.readFileString("relative.txt")).toBe("rooted")
            expect(yield* native.exists("relative.txt")).toBe(true)
            expect(yield* fs.exists(`${session.workdir}/relative.txt`)).toBe(true)
            // The native overrides serve the rest of the surface with the
            // same rooting, dot prefixes included.
            expect((yield* native.stat("./relative.txt")).type).toBe("File")
            yield* native.makeDirectory("native/dir", { recursive: true })
            yield* native.rename("relative.txt", "native/dir/moved.txt")
            expect(yield* native.readDirectory(".")).toContain("native")
            expect(yield* fs.exists(`${session.workdir}/native/dir/moved.txt`)).toBe(true)
            yield* fs.symlink(`${session.workdir}/native/dir/moved.txt`, `${session.workdir}/native.link`)
            expect(yield* native.readLink("native.link")).toBe(`${session.workdir}/native/dir/moved.txt`)
            expect(yield* native.realPath("native.link")).toBe(`${session.workdir}/native/dir/moved.txt`)
            yield* native.remove("native", { recursive: true })
            expect(yield* native.exists("native")).toBe(false)
            // Against a real tree, an unforced removal of a missing path is
            // NotFound and a forced one succeeds, matching the host.
            expect(
              String(yield* Effect.flip(probed.remove("gone.txt")))
            ).toContain("NotFound")
            yield* probed.remove("gone.txt", { force: true })
          })
        )
      }),
    budget
  )

  it.effect("keeps sessions in distinct workspaces and removes them on release", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const { fs } = yield* services
      const workdirs = yield* Effect.scoped(
        Effect.gen(function*() {
          const one = yield* directory.acquire("lane/one")
          const other = yield* directory.acquire("lane-one")
          yield* one.writeFile(`${one.workdir}/proof.txt`, new TextEncoder().encode("one"))
          expect(one.workdir).not.toBe(other.workdir)
          expect(yield* fs.exists(`${other.workdir}/proof.txt`)).toBe(false)
          return [one.workdir, other.workdir]
        })
      )
      for (const workdir of workdirs) {
        expect(yield* fs.exists(workdir)).toBe(false)
      }
    }), budget)

  it.effect(
    "forks a session into its own copied workspace and removes it with the scope",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const { fs } = yield* services
        const outcome = yield* Effect.scoped(
          Effect.gen(function*() {
            const parent = yield* directory.acquire("fan/main")
            yield* parent.writeFile(`${parent.workdir}/src/app.ts`, new TextEncoder().encode("parent"))
            const [child] = yield* Sandbox.fanOut(parent, { count: 1 })
            const copied = new TextDecoder().decode(yield* child!.readFile(`${child!.workdir}/src/app.ts`))
            yield* child!.writeFile(`${child!.workdir}/src/app.ts`, new TextEncoder().encode("child"))
            const parentAfter = new TextDecoder().decode(yield* parent.readFile(`${parent.workdir}/src/app.ts`))
            const ran = yield* Effect.scoped(
              Effect.flatMap(
                child!.spawn("cat src/app.ts", {}),
                (running) => Stream.mkString(Stream.decodeText(running.stdout))
              )
            )
            return { copied, parentAfter, ran, child: child!, parent }
          })
        )
        expect(outcome.child.id).toMatch(/^fan\/main\/[0-9a-f-]{36}\/child-0$/)
        expect(outcome.child.workdir).not.toBe(outcome.parent.workdir)
        expect(outcome.copied).toBe("parent")
        expect(outcome.parentAfter).toBe("parent")
        expect(outcome.ran).toBe("child")
        expect(yield* fs.exists(outcome.child.workdir)).toBe(false)
        expect(yield* fs.exists(outcome.parent.workdir)).toBe(false)
      }),
    budget
  )

  it.effect("forks without vendor sign-ins, and keeps concurrent batches apart", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const { fs } = yield* services
      const encode = (text: string) => new TextEncoder().encode(text)
      yield* Effect.scoped(
        Effect.gen(function*() {
          const parent = yield* directory.acquire("fan/home")
          yield* parent.writeFile(`${parent.workdir}/.codex/auth.json`, encode("{}"))
          yield* parent.writeFile(`${parent.workdir}/.claude.json`, encode("{}"))
          yield* parent.writeFile(`${parent.workdir}/.config/anthropic/key`, encode("sk"))
          yield* parent.writeFile(`${parent.workdir}/.codex/config.toml`, encode("kept"))
          const first = yield* Effect.scoped(
            Effect.gen(function*() {
              const [child] = yield* Sandbox.fanOut(parent, { count: 1 })
              const [other] = yield* Effect.scoped(Sandbox.fanOut(parent, { count: 1 }))
              // The inner batch closed; the outer child is untouched.
              expect(yield* fs.exists(other!.workdir)).toBe(false)
              expect(yield* fs.exists(child!.workdir)).toBe(true)
              for (const login of [".codex/auth.json", ".claude.json", ".config/anthropic/key"]) {
                expect(yield* fs.exists(`${child!.workdir}/${login}`)).toBe(false)
              }
              expect(yield* fs.readFileString(`${child!.workdir}/.codex/config.toml`)).toBe("kept")
              return child!
            })
          )
          expect(yield* fs.exists(first.workdir)).toBe(false)
          expect(yield* fs.exists(`${parent.workdir}/.codex/auth.json`)).toBe(true)
        })
      )
    }), budget)

  it.effect("reports a fork whose source workspace is gone as unavailable", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const { fs } = yield* services
      const error = yield* Effect.scoped(
        Effect.gen(function*() {
          const parent = yield* directory.acquire("fan/vanished")
          yield* fs.remove(parent.workdir, { recursive: true })
          return yield* Effect.flip(parent.fork!("fan/vanished/child"))
        })
      )
      expect(error.code).toBe("unavailable")
      expect(error.message).toContain("could not be forked")
    }), budget)

  it.effect(
    "runs commands in the session workdir with the caller's environment and real signals",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("spawn-shape")
            const output = yield* Effect.scoped(
              Effect.flatMap(
                session.spawn(`printf '%s:%s' "$PWD" "$DIRECTORY_SANDBOX_PROOF"`, {
                  env: { DIRECTORY_SANDBOX_PROOF: "delivered" }
                }),
                (process) => Stream.mkString(Stream.decodeText(process.stdout))
              )
            )
            expect(output).toBe(`${session.workdir}:delivered`)
            const elsewhere = yield* Effect.scoped(
              Effect.flatMap(
                session.spawn("pwd", { cwd: root }),
                (process) => Stream.mkString(Stream.decodeText(process.stdout))
              )
            )
            expect(elsewhere.trim()).toBe(root)
            // Only bootstrap names and caller declarations cross the process
            // boundary; an `undefined` declaration removes even an inherited
            // value instead of arriving as text.
            const hostPath = globalThis.process.env.PATH
            const previousAnthropic = globalThis.process.env.ANTHROPIC_API_KEY
            const previousOpenAi = globalThis.process.env.OPENAI_API_KEY
            const previousGithub = globalThis.process.env.GH_TOKEN
            globalThis.process.env.DIRECTORY_SANDBOX_DROPPED = "inherited"
            globalThis.process.env.ANTHROPIC_API_KEY = "ambient-anthropic"
            globalThis.process.env.OPENAI_API_KEY = "ambient-openai"
            globalThis.process.env.GH_TOKEN = "ambient-github"
            const merged = yield* Effect.scoped(
              Effect.flatMap(
                session.spawn(
                  "printenv",
                  { env: { DIRECTORY_SANDBOX_PROOF: "delivered", DIRECTORY_SANDBOX_DROPPED: undefined } }
                ),
                stdoutOf
              )
            ).pipe(Effect.ensuring(Effect.sync(() => {
              delete globalThis.process.env.DIRECTORY_SANDBOX_DROPPED
              if (previousAnthropic === undefined) delete globalThis.process.env.ANTHROPIC_API_KEY
              else globalThis.process.env.ANTHROPIC_API_KEY = previousAnthropic
              if (previousOpenAi === undefined) delete globalThis.process.env.OPENAI_API_KEY
              else globalThis.process.env.OPENAI_API_KEY = previousOpenAi
              if (previousGithub === undefined) delete globalThis.process.env.GH_TOKEN
              else globalThis.process.env.GH_TOKEN = previousGithub
            })))
            const environment = Object.fromEntries(
              merged.trim().split("\n").map((entry) => {
                const separator = entry.indexOf("=")
                return [entry.slice(0, separator), entry.slice(separator + 1)]
              })
            )
            expect(environment).toMatchObject({ PATH: hostPath, DIRECTORY_SANDBOX_PROOF: "delivered" })
            expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY")
            expect(environment).not.toHaveProperty("OPENAI_API_KEY")
            expect(environment).not.toHaveProperty("GH_TOKEN")
            expect(environment).not.toHaveProperty("DIRECTORY_SANDBOX_DROPPED")
          })
        )
      }),
    budget
  )

  it.effect(
    "roots a relative cwd under the session workdir, never under the engine process's",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("relative-cwd")
            yield* session.writeFile(`${session.workdir}/sub/dir/marker`, new Uint8Array())
            const pwd = (cwd: string) =>
              Effect.map(Effect.scoped(Effect.flatMap(session.spawn("pwd", { cwd }), stdoutOf)), (out) => out.trim())
            expect(yield* pwd("sub/dir")).toBe(`${session.workdir}/sub/dir`)
            expect(yield* pwd("./sub")).toBe(`${session.workdir}/sub`)
            expect(yield* pwd(".")).toBe(session.workdir)
            expect(yield* pwd("")).toBe(session.workdir)
            expect(yield* pwd(root)).toBe(root)
          })
        )
      }),
    budget
  )

  it.effect("delivers the caller's stdin bytes as the command's whole standard input", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("stdin-bytes")
          const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])
          const echoed = yield* Effect.scoped(
            Effect.gen(function*() {
              const running = yield* session.spawn("cat", { stdin: bytes })
              const [chunks, code] = yield* Effect.all(
                [Stream.runCollect(running.stdout), running.exitCode],
                { concurrency: "unbounded" }
              )
              return { bytes: chunks.flatMap((chunk) => Array.from(chunk)), code }
            })
          )
          expect(echoed).toEqual({ bytes: Array.from(bytes), code: 0 })
          // An empty input is still an input: the command sees end-of-file,
          // not a pipe nobody will ever close.
          const empty = yield* Effect.scoped(
            Effect.flatMap(session.spawn("cat", { stdin: new Uint8Array() }), (running) => running.exitCode)
          )
          expect(empty).toBe(0)
        })
      )
    }), budget)

  it.effect(
    "kill ends the command and everything it started, not only the shell that wrapped it",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        // Two shapes of work that outlive a signal aimed at the shell alone: a
        // background job the shell forked, and a grandchild that moved into its
        // own process group (Node's `detached`), which a process-group signal
        // from the spawner cannot reach either. Each fixture prints its own pid
        // and then the pid of the process that must not survive it; the
        // durations are distinctive so a stray host `sleep` cannot be mistaken
        // for the leak, and none is 3607, the duration
        // `posixCommands.survivor` greps for, so a concurrent conformance run
        // cannot mistake these fixtures for its own leak either.
        //
        // A fixture that can finish on its own turns a kill that did nothing
        // into a kill that looks like it worked. `wait` and a bare pipeline
        // both could: POSIX `wait` with no operands reports 0 once every child
        // is gone, and a pipeline reports its last member's status, so a loaded
        // runner that let the shell reap the descendant this kill signals first
        // (in the window before the shell's own signal landed) watched the
        // wrapper exit 0. Every wrapper below ends on `cat gate` instead, a
        // fifo nothing ever opens for writing, so it is parked in `open` and a
        // signal is the only thing that can end it.
        const gate = `${root}/kill-tree-gate`
        rmSync(gate, { force: true })
        expect(spawnSync("mkfifo", [gate]).status).toBe(0)
        const parked = `cat ${CommandLine.quote(gate)}`
        const node = CommandLine.quote(globalThis.process.execPath)
        const fixtures = [
          `sleep 3709 & echo $$; echo $!; ${parked}`,
          `echo $$; ${node} -e 'const child = require("node:child_process").spawn("sleep", ["3611"], ` +
          `{ detached: true, stdio: "ignore" }); console.log(child.pid); setInterval(() => {}, 1e6)'`
        ]
        const started: Array<number> = []
        const groups: Array<number> = []
        const own = (pid: number) => {
          started.push(pid)
          const group = Number.isInteger(pid) ? groupOf(pid) : undefined
          if (group !== undefined) groups.push(group)
        }
        const control = yield* lookalike("3719")
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("kill-tree")
            for (const line of fixtures) {
              const outcome = yield* Effect.scoped(
                Effect.gen(function*() {
                  const running = yield* session.spawn(line, {})
                  const [wrapper = Number.NaN, pid = Number.NaN] = yield* printedPids(running, 2)
                  own(wrapper)
                  own(pid)
                  expect([wrapper, pid].every(Number.isInteger), `\`${line}\` printed a wrapper and a victim pid`)
                    .toBe(true)
                  expect(processIsAlive(pid)).toBe(true)
                  // The kill must be the only thing that can end this wrapper.
                  // A fixture that finished early would make the exit below a
                  // success, and the assertion on it would read a kill that
                  // never landed as a kill that failed to stop anything.
                  expect(
                    processHasEnded(wrapper),
                    `the wrapper ${wrapper} running \`${line}\` ended before the kill was issued`
                  ).toBe(false)
                  yield* session.kill!(running, "SIGTERM")
                  return { pid, exit: yield* Effect.exit(running.exitCode) }
                })
              )
              // The wrapper's end is all the conformance suite can see; the leak
              // is only visible from the host.
              expect(Exit.isSuccess(outcome.exit) && outcome.exit.value === 0).toBe(false)
              yield* waitFor(() => processHasEnded(outcome.pid), `the work under \`${line.slice(0, 16)}\` to end`)
            }
            // A pipeline is the shape that forks on every shell: no member can
            // print another's pid, so the host is asked instead, with a bracket
            // that keeps the probe's own command line out of the match. The
            // parked `cat` is the pipeline's last member, so the status the
            // shell reports is a signalled one however the kill interleaves.
            const piped = yield* Effect.scoped(
              Effect.gen(function*() {
                const running = yield* session.spawn(`echo $$; sleep 3719 | ${parked}`, {})
                const [wrapper = Number.NaN] = yield* printedPids(running, 1)
                own(wrapper)
                const pipelineSleep = () =>
                  ownedProcesses([wrapper], groups).some(({ args }) => args.includes("sleep 3719"))
                yield* waitFor(pipelineSleep, "the pipeline to start")
                expect(
                  processHasEnded(wrapper),
                  `the pipeline's wrapper ${wrapper} ended before the kill was issued`
                ).toBe(false)
                yield* session.kill!(running, "SIGTERM")
                return { exit: yield* Effect.exit(running.exitCode), pipelineSleep }
              })
            )
            expect(Exit.isSuccess(piped.exit) && piped.exit.value === 0).toBe(false)
            yield* waitFor(() => !piped.pipelineSleep(), "the pipeline's sleep to end")
          })
        ).pipe(Effect.ensuring(Effect.sync(() => killOwned(started, groups))))
        yield* control.survived
      }).pipe(Effect.scoped),
    budget
  )

  // The contained host owns the whole group even when the shell forks its work.
  it.effect(
    "closing a spawn's scope ends everything the command started",
    () =>
      Effect.gen(function*() {
        const { fs, spawner } = yield* services
        const directory = DirectorySandbox.make({ fs, spawner, root })
        const started: Array<number> = []
        const groups: Array<number> = []
        const control = yield* lookalike("3809")
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("scope-closure")
            const background = yield* Effect.scoped(
              Effect.gen(function*() {
                const running = yield* session.spawn("echo $$; sleep 3809 & echo $!; wait", {})
                const [wrapper = Number.NaN, pid = Number.NaN] = yield* printedPids(running, 2)
                started.push(wrapper, pid)
                const group = Number.isInteger(wrapper) ? groupOf(wrapper) : undefined
                if (group !== undefined) groups.push(group)
                expect(processIsAlive(pid)).toBe(true)
                return pid
              })
            )
            yield* waitFor(() => processHasEnded(background), "the work the closed scope left behind to end")
          })
        ).pipe(Effect.ensuring(Effect.sync(() => killOwned(started, groups))))
        yield* control.survived
      }).pipe(Effect.scoped),
    budget
  )

  it.live(
    "finishes inherited output and closes the group after observing the target's natural exit",
    () =>
      Effect.gen(function*() {
        const token = randomUUID()
        const heartbeat = join(root, `${token}.heartbeat`)
        const trigger = join(root, `${token}.start`)
        const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
          JSON.stringify(heartbeat)
        };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,25)`
        const leader =
          `const fs=require('node:fs');const{spawn}=require('node:child_process');const timer=setInterval(()=>{if(!fs.existsSync(${
            JSON.stringify(trigger)
          }))return;clearInterval(timer);spawn(process.execPath,['-e',${
            JSON.stringify(child)
          }],{stdio:['ignore','inherit','inherit']});const ready=setInterval(()=>{if(fs.existsSync(${
            JSON.stringify(heartbeat)
          })){clearInterval(ready);process.stdout.write('complete\\n',()=>process.exit(0))}},5)},5)`
        const readBeat = (): { token: string; pid: number; tick: number } | undefined => {
          try {
            return JSON.parse(readFileSync(heartbeat, "utf8"))
          } catch {
            return undefined
          }
        }
        const identity = (pid: number): string => {
          const row = ProcessTable.query({ pid, columns: ["pid", "stat", "lstart", "args"], timeoutMs: 2000 }).trim()
          return row === "" ? "gone" : row
        }
        try {
          const directory = yield* provider
          const output = yield* Effect.scoped(
            Effect.gen(function*() {
              const session = yield* directory.acquire(`natural-${token}`)
              const running = yield* session.spawn(
                `${CommandLine.quote(process.execPath)} -e ${CommandLine.quote(leader)}`,
                {}
              )
              // The child appears only after the host has returned its handle.
              writeFileSync(trigger, "start")
              const [output, code] = yield* Effect.all([stdoutOf(running), running.exitCode], {
                concurrency: "unbounded"
              })
              expect(code).toBe(0)
              return output
            }).pipe(Effect.timeout("5 seconds"))
          )
          expect(output).toBe("complete\n")
          const before = readBeat()
          expect(before?.token).toBe(token)
          yield* Effect.sleep(150)
          const after = readBeat()
          expect(after).toEqual(before)
          const current = identity(after!.pid)
          expect(current === "gone" || /^\d+\s+Z/.test(current), current).toBe(true)
        } finally {
          const beat = readBeat()
          if (beat?.token === token && identity(beat.pid).includes(token)) {
            try {
              process.kill(beat.pid, "SIGKILL")
            } catch (error) {
              if (!isErrno(error, "ESRCH")) throw error
            }
          }
        }
      }),
    budget
  )

  it.live("fails scope release when the contained handle refuses cleanup", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const native = yield* ChildProcessSpawner.pipe(Effect.provide(rawPlatform))
      const refusing = yield* contain(native, (command, spawn) =>
        ProcessReaper.processLifecycle(command, spawn).pipe(Effect.map((prepared) => ({
          ...prepared,
          handle: {
            ...prepared.handle,
            kill: () =>
              Effect.fail(PlatformError.badArgument({
                module: "ChildProcess",
                method: "kill",
                description: "cleanup was not confirmed"
              }))
          }
        }))))
      const closed = yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* DirectorySandbox.make({ fs, spawner: refusing, root }).acquire("cleanup-refusal")
        const running = yield* session.spawn("true", {})
        expect(yield* running.exitCode).toBe(0)
      })).pipe(Effect.exit)
      expect(Exit.isFailure(closed)).toBe(true)
      expect(String(closed)).toContain("the signal SIGTERM could not be delivered")
    }), budget)

  it.effect("reports a signal it could not deliver and leaves an exited command alone", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const { fs } = yield* services
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("kill-edges")
          // The host's `kill` knows no BREAK and the command is still running,
          // so nothing was delivered, and the session says so.
          const refused = yield* Effect.scoped(
            Effect.gen(function*() {
              const running = yield* session.spawn("sleep 3613", {})
              const failure = yield* Effect.flip(session.kill!(running, "SIGBREAK"))
              yield* session.kill!(running, "SIGTERM")
              yield* Effect.exit(running.exitCode)
              return failure
            })
          )
          expect(refused).toBeInstanceOf(ProviderError)
          expect((refused as ProviderError).code).toBe("unknown")
          expect((refused as ProviderError).message).toContain("SIGBREAK")
          // A command that has already exited is left alone: its pid may be
          // someone else's by now, and the signal's purpose already holds.
          yield* Effect.scoped(
            Effect.gen(function*() {
              const running = yield* session.spawn("true", {})
              expect(yield* running.exitCode).toBe(0)
              yield* session.kill!(running, "SIGTERM")
            })
          )
        })
      )
      // A failed handle signal is reported directly; the provider must not
      // spawn a second shell to signal a numeric pid behind the lifecycle.
      const native = yield* ChildProcessSpawner.pipe(Effect.provide(rawPlatform))
      let refusedOnce = false
      const refusing = yield* contain(native, (command, spawn) =>
        ProcessReaper.processLifecycle(command, spawn).pipe(Effect.map((prepared) => ({
          ...prepared,
          handle: {
            ...prepared.handle,
            kill: (options?: ChildProcess.KillOptions) =>
              Effect.suspend(() => {
                if (refusedOnce) {
                  return prepared.handle.kill(options)
                }
                refusedOnce = true
                return Effect.fail(PlatformError.badArgument({
                  module: "ChildProcess",
                  method: "kill",
                  description: "signal transport refused"
                }))
              })
          }
        }))))
      const undelivered = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* DirectorySandbox.make({ fs, spawner: refusing, root }).acquire("refused-signal")
          const running = yield* session.spawn("sleep 3617", {})
          return yield* Effect.flip(session.kill!(running, "SIGTERM"))
        })
      )
      expect((undelivered as ProviderError).code).toBe("unknown")
      expect((undelivered as ProviderError).message).toContain("SIGTERM")
    }), budget)

  it.effect("refuses a spawn against a command that cannot start", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const spawner = yield* contain(
        makeSpawner(() =>
          Effect.fail(
            PlatformError.badArgument({
              module: "ChildProcess",
              method: "spawn",
              description: "broken transport"
            })
          )
        ),
        ProcessReaper.processLifecycle
      )
      const directory = DirectorySandbox.make({ fs, spawner, root })
      const failure = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("broken-spawner")
          return yield* Effect.flip(Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
        })
      )
      expect(failure).toBeInstanceOf(ProviderError)
      expect((failure as ProviderError).code).toBe("spawn_error")
    }), budget)

  it.effect("reports an unreadable path distinctly from an absent one", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("read-errors")
          const absent = yield* Effect.flip(session.readFile(`${session.workdir}/absent.txt`))
          // Reading a directory as a file is a real refusal, not absence.
          yield* session.writeFile(`${session.workdir}/dir/inner.txt`, new Uint8Array([1]))
          const unreadable = yield* Effect.flip(session.readFile(`${session.workdir}/dir`))
          return { absent, unreadable }
        })
      )
      expect((outcome.absent as ProviderError).code).toBe("not_found")
      expect((outcome.unreadable as ProviderError).code).toBe("unknown")
    }), budget)

  it.effect("provides the host bundle through layerHost against a real machine", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const files = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const workdir = (yield* spawner.string(ChildProcess.make("pwd", { shell: true }))).trim()
        const target = path.join(workdir, "from-tools.txt")
        yield* files.writeFileString(target, "written through the host bundle")
        const echoed = yield* spawner.string(ChildProcess.make(`cat ${target}`, { shell: true }))
        return { workdir, echoed }
      }).pipe(Effect.provide(Sandbox.layerHost(directory, { session: "host-bundle" })))
      expect(outcome.workdir.startsWith(root)).toBe(true)
      expect(outcome.echoed).toBe("written through the host bundle")
    }), budget)
})
