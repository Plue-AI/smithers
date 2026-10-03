/**
 * The suite is a judge, so these tests are trials: a REAL provider (scratch
 * directories, real shells) with exactly one operation broken per trial, and
 * the assertion that the suite names exactly that break. A suite only ever
 * shown conforming doubles would be a statement about nothing, and a trial
 * whose truthful half is fake would prove the suite agrees with the fake.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, vi } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { elapsed } from "../src/internal/deadline.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { platform } from "./helpers/containedPlatform.ts"
import { makeWorkSeed } from "./helpers/workSeed.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-conformance-trials-")))
const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-conformance-elsewhere-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

const services = Effect.runSync(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    return { fs, spawner }
  }).pipe(Effect.provide(platform))
)

const truthful = DirectorySandbox.make({ ...services, root })

/** A provider whose every acquired session is reshaped by one lie. */
const warped = (
  warp: (session: Sandbox.Session) => Sandbox.Session
): Sandbox.Provider => ({
  acquire: (key) => Effect.map(truthful.acquire(key), warp)
})

const checkNames = (violations: ReadonlyArray<{ readonly check: string }>): ReadonlyArray<string> =>
  violations.map((violation) => violation.check)

describe("SandboxConformance", () => {
  it.live("names a session that silently drops guest inherited environment deletions", () =>
    Effect.gen(function*() {
      const dropping = warped((session) => ({
        ...session,
        spawn: (command, options) =>
          session.spawn(command, {
            ...options,
            env: Object.fromEntries(Object.entries(options.env ?? {}).filter(([, value]) => value !== undefined))
          })
      }))
      expect(checkNames(yield* SandboxConformance.check(dropping)))
        .toContain("deletes-inherited-environment-or-refuses")
    }), 120_000)

  it.live("does not accept deleting an already absent guest variable as proof", () =>
    Effect.gen(function*() {
      const absent = warped((session) => ({
        ...session,
        spawn: (command, options) =>
          session.spawn(command, {
            ...options,
            env: { ...options.env, HOME: undefined }
          })
      }))
      expect(checkNames(yield* SandboxConformance.check(absent)))
        .toContain("deletes-inherited-environment-or-refuses")
    }), 120_000)

  for (const phase of ["acquire", "body", "release"] as const) {
    it.effect(`bounds a stuck session ${phase}, including reacquire, and starts cleanup`, () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const cleanups: Array<Deferred.Deferred<void>> = []
        let releases = 0
        const body = phase === "body" ? Deferred.await(gate) : Effect.void
        const session: Sandbox.Session = {
          id: "bounded",
          remoteId: "bounded",
          workdir: "/bounded",
          writeFile: () => body,
          readFile: () => Effect.as(body, new Uint8Array()),
          spawn: () =>
            Effect.as(body, {
              stdout: Stream.empty,
              stderr: Stream.empty,
              exitCode: Effect.succeed(0)
            })
        }
        const provider: Sandbox.Provider = {
          acquire: () =>
            Effect.acquireRelease(
              Effect.gen(function*() {
                const done = yield* Deferred.make<void>()
                cleanups.push(done)
                if (phase === "acquire") yield* Deferred.await(gate)
                return { session, done }
              }),
              ({ done }) =>
                Effect.gen(function*() {
                  releases++
                  if (phase === "release") yield* Deferred.await(gate)
                  yield* Deferred.succeed(done, undefined)
                })
            ).pipe(Effect.map(({ session }) => session))
        }
        const running = yield* Effect.forkDetach(SandboxConformance.check(provider, { checkTimeout: "20 millis" }))
        yield* Effect.gen(function*() {
          const violations = yield* Effect.raceFirst(Fiber.join(running), Effect.as(elapsed("2 seconds"), undefined))
          expect(violations, "the deadline must return before the stuck boundary is released").toBeDefined()
          for (const name of ["round-trips-binary-bytes", "reacquires-its-session", "writes-its-output"]) {
            expect(violations?.find(({ check }) => check === name)?.actual).toContain(
              "did not finish within 20 milliseconds"
            )
          }
          if (phase !== "acquire") expect(releases).toBeGreaterThan(0)
        }).pipe(Effect.ensuring(Effect.andThen(Deferred.succeed(gate, undefined), Fiber.interrupt(running))))
        // Timed-out checks still own their release, even after the suite returns.
        yield* Effect.all(cleanups.map(Deferred.await))
        expect(releases).toBe(cleanups.length)
      }))
  }

  // These trials run real OS processes. A cleanup observation may need a
  // clock-driven retry after native exit; a frozen TestClock never advances
  // that retry. Keep real deadlines here, as in ProviderConformance's trials.
  it.live(
    "reports nothing for a conforming provider and acquires the default session key",
    () =>
      Effect.gen(function*() {
        const acquired: Array<string> = []
        const recording: Sandbox.Provider = {
          acquire: (key) =>
            Effect.suspend(() => {
              acquired.push(key)
              return truthful.acquire(key)
            })
        }
        const violations = yield* SandboxConformance.check(recording, {
          provides: { kill: true, ping: true }
        })
        expect(violations).toEqual([])
        expect(acquired[0]).toBe("sandbox-conformance")
        expect(new Set(acquired).size).toBe(1)
      }),
    120_000
  )

  it.live("names a session that corrupts bytes or misreports absence", () =>
    Effect.gen(function*() {
      const corrupting = warped((session) => ({
        ...session,
        readFile: (path) => Effect.map(session.readFile(path), (bytes) => bytes.slice(0, bytes.length - 1))
      }))
      const corrupted = checkNames(yield* SandboxConformance.check(corrupting, { session: "trial-corrupt" }))
      expect(corrupted).toContain("round-trips-binary-bytes")
      expect(corrupted).toContain("round-trips-a-large-file")

      const wrongCode = warped((session) => ({
        ...session,
        readFile: (path) =>
          Effect.catch(session.readFile(path), () =>
            Effect.fail(new ProviderError({ code: "unknown", message: "something went wrong" })))
      }))
      expect(checkNames(yield* SandboxConformance.check(wrongCode, { session: "trial-code" })))
        .toContain("reports-an-absent-file")

      const fabricating = warped((session) => ({
        ...session,
        readFile: (path) =>
          Effect.catch(session.readFile(path), () => Effect.succeed(new Uint8Array([1])))
      }))
      expect(checkNames(yield* SandboxConformance.check(fabricating, { session: "trial-fabricate" })))
        .toContain("reports-an-absent-file")
    }), 120_000)

  it.live("names a session that refuses parent creation", () =>
    Effect.gen(function*() {
      const flat = warped((session) => ({
        ...session,
        writeFile: (path, content) =>
          path.includes("/conformance/")
            ? Effect.fail(new ProviderError({ code: "unknown", message: "no such directory" }))
            : session.writeFile(path, content)
      }))
      expect(checkNames(yield* SandboxConformance.check(flat, { session: "trial-parents" })))
        .toContain("creates-parent-directories")
    }), 120_000)

  it.live(
    "names a session that runs commands in the wrong place or drops env or stdin",
    () =>
      Effect.gen(function*() {
        const lost = (stdout: string): Sandbox.Session["spawn"] => () =>
          Effect.succeed({
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            exitCode: Effect.succeed(0)
          })
        const displaced = warped((session) => ({
          ...session,
          spawn: (command, options) =>
            command === "pwd" ? lost("/elsewhere\n")(command, options) : session.spawn(command, options)
        }))
        expect(checkNames(yield* SandboxConformance.check(displaced, { session: "trial-workdir" })))
          .toContain("runs-in-its-workdir")
        const deaf = warped((session) => ({
          ...session,
          spawn: (command, options) => session.spawn(command, { ...options, env: undefined })
        }))
        expect(checkNames(yield* SandboxConformance.check(deaf, { session: "trial-env" })))
          .toContain("delivers-the-environment")
        const starved = warped((session) => ({
          ...session,
          spawn: (command, options) => session.spawn(command, { ...options, stdin: undefined })
        }))
        expect(
          checkNames(yield* SandboxConformance.check(starved, { session: "trial-stdin", checkTimeout: "10 seconds" }))
        )
          .toContain("delivers-standard-input")
        const severed = warped((session) => ({
          ...session,
          spawn: (command, options) =>
            Effect.map(session.spawn(command, options), (process) => ({ ...process, stderr: Stream.empty }))
        }))
        expect(checkNames(yield* SandboxConformance.check(severed, { session: "trial-stderr" })))
          .toContain("delivers-standard-error")
      }),
    120_000
  )

  it.live("names a session whose files are not the machine its processes run on", () =>
    Effect.gen(function*() {
      // The split-brain session: a self-consistent file store that is NOT the
      // tree the shell sees. Every single-surface check passes against it;
      // only the cross-surface checks can convict it.
      const splitBrain = warped((session) => {
        const relocate = (path: string): string =>
          path.startsWith(session.workdir) ? `${elsewhere}${path.slice(session.workdir.length)}` : path
        return {
          ...session,
          readFile: (path) => session.readFile(relocate(path)),
          writeFile: (path, content) => session.writeFile(relocate(path), content)
        }
      })
      const names = checkNames(yield* SandboxConformance.check(splitBrain, { session: "trial-split" }))
      expect(names).toContain("files-reach-processes")
      expect(names).toContain("processes-reach-files")
      expect(names).not.toContain("round-trips-binary-bytes")
    }), 120_000)

  it.live("names a provider that cannot serve a session again after a bare release", () =>
    Effect.gen(function*() {
      // The reacquire sequence is the one place the suite acquires, releases
      // without running anything, and acquires again; failing exactly the
      // acquire after an unused session convicts it without counting checks.
      let armed = false
      const singleUse: Sandbox.Provider = {
        acquire: (key) =>
          Effect.gen(function*() {
            if (armed) {
              return yield* Effect.fail(
                new ProviderError({ code: "unavailable", message: "machine budget spent" })
              )
            }
            const session = yield* truthful.acquire(key)
            let used = false
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (!used) armed = true
              })
            )
            const touching = <A extends ReadonlyArray<unknown>, R>(operation: (...args: A) => R) => (...args: A): R => {
              used = true
              return operation(...args)
            }
            return {
              ...session,
              spawn: touching(session.spawn),
              readFile: touching(session.readFile),
              writeFile: touching(session.writeFile)
            }
          })
      }
      expect(checkNames(yield* SandboxConformance.check(singleUse, { session: "trial-reacquire" })))
        .toContain("reacquires-its-session")
    }), 120_000)

  it.live("carries the delegated spawn violations up whole", () =>
    Effect.gen(function*() {
      const silent = warped((session) => ({
        ...session,
        spawn: (command, options) =>
          command === SandboxConformance.posixCommands.writes
            ? Effect.succeed({
              stdout: Stream.make(new TextEncoder().encode("wrong words")),
              stderr: Stream.empty,
              exitCode: Effect.succeed(0)
            })
            : command === SandboxConformance.posixCommands.fails
            ? Effect.succeed({ stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) })
            : session.spawn(command, options)
      }))
      const names = checkNames(
        yield* SandboxConformance.check(silent, {
          session: "trial-delegated",
          commands: SandboxConformance.posixCommands
        })
      )
      expect(names).toEqual(expect.arrayContaining(["writes-its-output", "reports-a-nonzero-exit"]))
    }), 120_000)

  it.live("names a session whose command outlives its interrupted caller", () =>
    Effect.gen(function*() {
      // The lie: every command runs in a scope of its own that nothing ever
      // closes, so interrupting the caller reaches nothing.
      const detached = warped((session) => ({
        ...session,
        spawn: (command, options) =>
          Effect.flatMap(Scope.make(), (orphaned) => Scope.provide(session.spawn(command, options), orphaned))
      }))
      expect(
        checkNames(
          yield* SandboxConformance.check(detached, {
            session: "trial-interrupt",
            provides: { interrupt: true },
            commands: SandboxConformance.posixCommands
          })
        )
      ).toContain("interrupts-a-running-command")
    }), 120_000)

  it.live("names a session whose release keeps what it wrote", () =>
    Effect.gen(function*() {
      // The lie: a file written before the release is still there after it.
      const keeping = warped((session) => ({
        ...session,
        readFile: (path) =>
          path.endsWith("/conformance-ephemeral.bin") ? Effect.succeed(new Uint8Array([1])) : session.readFile(path)
      }))
      expect(
        checkNames(
          yield* SandboxConformance.check(keeping, {
            session: "trial-ephemeral",
            provides: { ephemeral: true },
            commands: SandboxConformance.posixCommands
          })
        )
      ).toContain("releases-ephemeral-state")
    }), 120_000)

  it.live(
    "judges a host-path isolation claim by the file surface and a guest probe together",
    () =>
      Effect.gen(function*() {
        const options = (session: string) => ({
          session,
          isolation: { hostSentinel: elsewhere },
          commands: SandboxConformance.posixCommands
        })
        // A directory session reaches every host path.
        expect(checkNames(yield* SandboxConformance.check(truthful, options("trial-hidden-open"))))
          .toContain("hides-host-paths")
        // Both surfaces deny the sentinel: the claim holds.
        const hiding = warped((session) => ({
          ...session,
          readFile: (path) =>
            path === elsewhere
              ? Effect.fail(new ProviderError({ code: "not_found", message: `nothing at ${path}` }))
              : session.readFile(path),
          spawn: (command, spawnOptions) =>
            session.spawn(command.startsWith("test -e ") ? "exit 1" : command, spawnOptions)
        }))
        expect(checkNames(yield* SandboxConformance.check(hiding, options("trial-hidden"))))
          .not.toContain("hides-host-paths")
      }),
    120_000
  )

  for (
    const [probe, verdict] of [
      ["exit 0", "egress reached"],
      ["exit 127", "the probe could not run (exit 127), so egress is unproven"],
      ["exit 1", undefined]
    ] as const
  ) {
    it.live(`judges an egress claim whose probe runs \`${probe}\``, () =>
      Effect.gen(function*() {
        const violations = yield* SandboxConformance.check(truthful, {
          session: `trial-egress-${probe.replace(" ", "-")}`,
          isolation: { egressProbe: probe },
          commands: SandboxConformance.posixCommands
        })
        const refused = violations.find(({ check }) => check === "refuses-egress")
        if (verdict === undefined) expect(refused).toBeUndefined()
        else if (verdict === "egress reached") expect(refused?.actual).toContain("0")
        else expect(refused?.actual).toBe(verdict)
      }), 120_000)
  }

  it("builds its default fixture on a host with no Node globals at all", async () => {
    // This module is part of a package whose contract is that it is
    // platform-neutral and browser-bundleable, and `check` defaults its
    // fixture to `uniquePosixCommands`. A free `process` identifier is not a
    // bundling error: it survives the bundle and throws `ReferenceError` in a
    // browser on the first call. The whole module is reloaded without
    // `globalThis.process` so its load-time work is judged too.
    const host = globalThis as { process?: unknown }
    const node = host.process
    vi.resetModules()
    try {
      delete host.process
      const fresh = await import("../src/SandboxConformance/posixCommands.ts")
      const first = fresh.uniquePosixCommands()
      const second = fresh.uniquePosixCommands()
      for (const commands of [first, second]) {
        const duration = /^sleep (\d{6})$/.exec(commands.runs)?.[1]
        expect(duration).toBeDefined()
        // The survivor pattern brackets the fixture's last digit so it cannot
        // match its own command line.
        expect(commands.survivor).toBe(`pgrep -f 'sleep ${duration!.slice(0, -1)}[${duration!.slice(-1)}]'`)
        expect(commands.shell).toBe(true)
      }
      // Two runs on one host never share a duration, which is the whole point
      // of the per-call fixture.
      expect(first.runs).not.toBe(second.runs)
    } finally {
      host.process = node
      vi.resetModules()
    }
  })

  describe("work", () => {
    const work = makeWorkSeed()
    // A work check spawns git about a dozen times; a loaded host must not
    // turn a slow truthful session into a deadline violation.
    const workOptions = (session: string): SandboxConformance.CheckOptions => ({
      session,
      work,
      checkTimeout: "60 seconds",
      commands: SandboxConformance.posixCommands
    })
    const workNames = (violations: ReadonlyArray<{ readonly check: string }>) =>
      checkNames(violations).filter((name) => name.startsWith("captures-"))

    it.live("holds a real directory session to the work contract", () =>
      Effect.gen(function*() {
        expect(workNames(yield* SandboxConformance.check(truthful, workOptions("trial-work")))).toEqual([])
      }), 120_000)

    it.live("skips the work checks without a seed", () =>
      Effect.gen(function*() {
        const violations = yield* SandboxConformance.check(truthful, {
          session: "trial-work-unseeded",
          commands: SandboxConformance.posixCommands
        })
        expect(workNames(violations)).toEqual([])
      }), 120_000)

    it.live("names a capture that drops untracked files", () =>
      Effect.gen(function*() {
        // The lie: the private index never learns untracked files, the classic
        // `git diff HEAD` capture. Only applying the patch shows the loss.
        const dropping = warped((session) => ({
          ...session,
          spawn: (command, options) =>
            session.spawn(
              command.includes("diff --cached") ? command.replace("git add -A .", "git add -u .") : command,
              options
            )
        }))
        const violations = yield* SandboxConformance.check(dropping, workOptions("trial-work-untracked"))
        expect(workNames(violations)).toEqual(["captures-its-work"])
        expect(violations.find(({ check }) => check === "captures-its-work")?.actual).toContain(
          "\"reproduced\":false"
        )
      }), 120_000)

    it.live("names a capture that loses renames", () =>
      Effect.gen(function*() {
        const renameless = warped((session) => ({
          ...session,
          spawn: (command, options) => session.spawn(command.replace("--find-renames", "--no-renames"), options)
        }))
        const violations = yield* SandboxConformance.check(renameless, workOptions("trial-work-renames"))
        expect(workNames(violations)).toEqual(["captures-its-work"])
        expect(violations.find(({ check }) => check === "captures-its-work")?.actual).toContain(
          "\"renamed\":false"
        )
      }), 120_000)

    it.live("names a capture that sees no work, and one that invents it", () =>
      Effect.gen(function*() {
        // Every capture answers with the opposite of the truth.
        const inverted = (empty: boolean) =>
          warped((session) => ({
            ...session,
            spawn: (command, options) =>
              command.includes("diff --cached")
                ? Effect.map(session.spawn(command, options), (process) => ({
                  ...process,
                  stdout: empty ? Stream.empty : Stream.make(new TextEncoder().encode("invented\n"))
                }))
                : session.spawn(command, options)
          }))
        const blind = yield* SandboxConformance.check(inverted(true), workOptions("trial-work-blind"))
        expect(workNames(blind)).toEqual(["captures-its-work"])
        expect(blind.find(({ check }) => check === "captures-its-work")?.actual).toContain("\"Unchanged\"")
        const inventing = yield* SandboxConformance.check(inverted(false), workOptions("trial-work-invent"))
        expect(workNames(inventing)).toEqual(["captures-its-work", "captures-no-work"])
      }), 120_000)

    it.live("names a session whose guest has no git", () =>
      Effect.gen(function*() {
        const gitless = warped((session) => ({
          ...session,
          // A shell function shadows git the way a missing binary would.
          spawn: (command, options) => session.spawn(`git() { return 127; }\n${command}`, options)
        }))
        const violations = yield* SandboxConformance.check(gitless, workOptions("trial-work-gitless"))
        expect(workNames(violations)).toEqual(["captures-its-work", "captures-no-work"])
        const actual = violations.find(({ check }) => check === "captures-no-work")?.actual
        expect(actual).toContain("exit 127")
        expect(actual).toContain("@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError")
      }), 120_000)
  })
})
