/**
 * `NodeJj.layerSpawner`, driven against a stand-in `jj` at an explicit path.
 *
 * The layer exists so a host that contains what it spawns contains jj too: a
 * `jj` child started around the host's spawner leads no process group the host
 * recorded, is in no `ProcessLedger`, and is never reaped. What has to be true
 * of it is that routing jj through a spawner changes NOTHING a caller can
 * observe: the same commands, the same stdout, and the same classified errors
 * as the self-spawning layer. These cases run a real `jj` shim through a real
 * spawner adapter and check exactly that.
 */
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as EffectChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const script = `#!/bin/sh
case "$1" in
  --version) echo "jj 0.39.0"; exit 0 ;;
  restore) echo "Warning: Refused to snapshot some files:" 1>&2; exit 0 ;;
  status) echo "the working copy is clean"; exit 0 ;;
  root) pwd; exit 0 ;;
  diff) echo "Error: Revision not found" 1>&2; exit 1 ;;
  *) exit 0 ;;
esac
`

/** A second binary, reachable only by name, for the override case. */
const overrideScript = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
echo "answered by the override"
exit 0
`

const directory = mkdtempSync(join(tmpdir(), "flows-jj-spawner-"))
writeFileSync(join(directory, "jj"), script)
chmodSync(join(directory, "jj"), 0o755)
const overrideBinary = join(directory, "override-jj")
writeFileSync(overrideBinary, overrideScript)
chmodSync(overrideBinary, 0o755)
const oldBinary = join(directory, "old-jj")
writeFileSync(oldBinary, "#!/bin/sh\necho \"jj 0.38.0\"\n")
chmodSync(oldBinary, 0o755)

// The adapter honours SMITHERS_JJ_PATH, so a developer who has one set would
// otherwise change which binary these cases spawn.
const previousJj = process.env.SMITHERS_JJ_PATH
beforeEach(() => {
  process.env.SMITHERS_JJ_PATH = join(directory, "jj")
})
afterEach(() => {
  if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
  else process.env.SMITHERS_JJ_PATH = previousJj
})

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const encode = (text: string) => Stream.make(new TextEncoder().encode(text))

/**
 * A `ChildProcessSpawner` over `node:child_process`.
 *
 * `@smthrs/jj` does not depend on a platform bundle, so the adapter is written
 * out here rather than imported. It is deliberately the smallest real one: it
 * starts the process, collects both streams, and reports the exit code.
 */
const spawnerWithPath = (path: string, calls: Array<EffectChildProcess.StandardCommand> = [], executable?: string) =>
  Layer.succeed(ChildProcessSpawner)(
    makeSpawner((command: EffectChildProcess.Command) =>
      Effect.sync(() => {
        const standard = command as EffectChildProcess.StandardCommand
        calls.push(standard)
        const child = spawn(executable ?? standard.command, [...standard.args], {
          cwd: standard.options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PATH: path }
        })
        let stdout = ""
        let stderr = ""
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8")
        })
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8")
        })
        const finished = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)))
        const settled = Effect.promise(() => finished)
        return makeHandle({
          pid: ProcessId(child.pid ?? 0),
          exitCode: Effect.map(settled, (code) => ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.unwrap(Effect.map(settled, () => encode(stdout))),
          stderr: Stream.unwrap(Effect.map(settled, () => encode(stderr))),
          all: Stream.unwrap(Effect.map(settled, () => encode(stdout + stderr))),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
  )

const realSpawner = spawnerWithPath(directory)

/**
 * A spawner whose child never stops talking.
 *
 * No process is started: the ceiling is a property of how the adapter reads a
 * handle's streams, and eighty mebibytes of scripted output reaches it faster
 * than a real child could produce them.
 */
const flood = Layer.succeed(ChildProcessSpawner)(
  makeSpawner((command) =>
    Effect.sync(() => {
      const version = (command as EffectChildProcess.StandardCommand).args.includes("--version")
      const chunk = new Uint8Array(1024 * 1024).fill("x".charCodeAt(0))
      return makeHandle({
        pid: ProcessId(0),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: version ? encode("jj 0.39.0") : Stream.fromIterable(Array.from({ length: 80 }, () => chunk)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
)

/** A spawner that reports what a host reports for a binary that is not there. */
const missingBinary = (allowVersion = false) =>
  Layer.effect(
    ChildProcessSpawner,
    Effect.map(ChildProcessSpawner, (real) =>
      makeSpawner((command) =>
        allowVersion && (command as EffectChildProcess.StandardCommand).args.includes("--version")
          ? real.spawn(command)
          : Effect.fail(
            PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn", description: "jj" })
          )
      ))
  ).pipe(Layer.provide(realSpawner))

const run = <A, E>(effect: Effect.Effect<A, E, Jj>, spawner: Layer.Layer<ChildProcessSpawner>) =>
  Effect.provide(effect, Layer.provide(budgeted(NodeJj.layerSpawnerAt(directory)), spawner))

process.on("exit", () => rmSync(directory, { recursive: true, force: true }))

describe.skipIf(process.platform === "win32")("NodeJj.layerSpawner", () => {
  it.effect("probes and runs the same absolute binary despite an older jj on the spawner PATH", () =>
    Effect.gen(function*() {
      const oldDirectory = mkdtempSync(join(tmpdir(), "flows-jj-old-path-"))
      writeFileSync(
        join(oldDirectory, "jj"),
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"jj 0.38.0\"; else echo OLD_EXECUTABLE_RAN; fi\n",
        { mode: 0o755 }
      )
      const previousPath = process.env.PATH
      const calls: Array<EffectChildProcess.StandardCommand> = []
      process.env.PATH = directory
      delete process.env.SMITHERS_JJ_PATH
      try {
        // A direct probe must not satisfy the spawner's own preflight.
        yield* Effect.provide(Jj, budgeted(NodeJj.layerAt(directory)))
        const spawner = spawnerWithPath(oldDirectory, calls)
        const jj = yield* run(Jj, spawner)
        yield* run(Jj, spawner)
        expect(yield* jj.status()).toBe("the working copy is clean\n")
        expect(calls.map((command) => command.command)).toEqual([join(directory, "jj"), join(directory, "jj")])
        expect(calls.map((command) => command.args[0])).toEqual(["--version", "status"])
        expect(calls[0]!.options.cwd).toBeUndefined()
        expect(calls[1]!.options.cwd).toBe(directory)
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        rmSync(oldDirectory, { recursive: true, force: true })
      }
    }))

  it.effect("checks the version reported by each host runner even after a passing direct probe", () =>
    Effect.gen(function*() {
      yield* Effect.provide(Jj, budgeted(NodeJj.layerAt(directory)))
      const calls: Array<EffectChildProcess.StandardCommand> = []
      const error = yield* Effect.flip(run(Jj, spawnerWithPath(directory, calls, oldBinary)))
      expect(error).toMatchObject({ code: "unsupported_version", method: "version" })
      expect(error.message).toContain("0.38.0")
      expect(calls.map((command) => command.args[0])).toEqual(["--version"])
    }))

  it.effect("does not let a repository replace a relative override through the host spawner", () =>
    Effect.gen(function*() {
      const trusted = mkdtempSync(join(tmpdir(), "flows-jj-trusted-"))
      const repository = join(trusted, "repository")
      mkdirSync(join(trusted, "bin"))
      mkdirSync(join(repository, "bin"), { recursive: true })
      writeFileSync(join(trusted, "bin", "jj"), script, { mode: 0o755 })
      writeFileSync(join(repository, "bin", "jj"), "#!/bin/sh\necho REPOSITORY_EXECUTABLE_RAN\n", { mode: 0o755 })
      const previousCwd = process.cwd()
      process.chdir(trusted)
      process.env.SMITHERS_JJ_PATH = "./bin/jj"
      try {
        const jj = yield* Effect.provide(Jj, Layer.provide(budgeted(NodeJj.layerSpawnerAt(repository)), realSpawner))
        expect(yield* jj.status()).toBe("the working copy is clean\n")
      } finally {
        process.chdir(previousCwd)
        rmSync(trusted, { recursive: true, force: true })
      }
    }))

  it.effect("refuses an unresolved host binary without spawning the bare fallback", () =>
    Effect.gen(function*() {
      const previousPath = process.env.PATH
      const calls: Array<EffectChildProcess.StandardCommand> = []
      process.env.PATH = ""
      delete process.env.SMITHERS_JJ_PATH
      try {
        const error = yield* Effect.flip(run(Jj, spawnerWithPath(directory, calls)))
        expect(error).toMatchObject({ code: "not_installed", method: "version" })
        expect(calls).toEqual([])
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
      }
    }))

  it.effect("trusts the version the injected spawner reports over an old local answer", () =>
    Effect.gen(function*() {
      // The host resolves the old binary, and a direct probe of it fails. A
      // spawner that executes a supported jj at that path is authoritative for
      // its own layer: it is asked, and the ambient answer never decides.
      process.env.SMITHERS_JJ_PATH = oldBinary
      const direct = yield* Effect.flip(Effect.provide(Jj, budgeted(NodeJj.layerAt(directory))))
      expect(direct).toMatchObject({ code: "unsupported_version", method: "version" })
      const calls: Array<EffectChildProcess.StandardCommand> = []
      const jj = yield* run(Jj, spawnerWithPath(directory, calls, join(directory, "jj")))
      expect(yield* jj.status()).toBe("the working copy is clean\n")
      expect(calls.map((command) => command.command)).toEqual([oldBinary, oldBinary])
      expect(calls.map((command) => command.args[0])).toEqual(["--version", "status"])
    }))

  it.effect("rejects an old local version before exposing the spawner-backed Jj", () =>
    Effect.gen(function*() {
      process.env.SMITHERS_JJ_PATH = oldBinary
      const error = yield* Effect.flip(run(Jj, realSpawner))
      expect(error).toMatchObject({ code: "unsupported_version", method: "version", command: "jj --version" })
      expect(error.message).toContain("0.39.0")
    }))

  it.effect("fails typed on refused-file warnings through the host spawner", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore("5a7ed"))), realSpawner)
      expect(error.code).toBe("snapshot_refused")
      expect(error.message).toContain("Refused to snapshot")
    }))

  it.effect("builds the unbound spawner layer and runs operations through the host", () =>
    Effect.gen(function*() {
      const output = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(
        Effect.provide(Layer.provide(budgeted(NodeJj.layerSpawner), realSpawner))
      )
      expect(output).toBe("the working copy is clean\n")
    }))

  it.effect("runs jj through the host spawner and returns its stdout", () =>
    Effect.gen(function*() {
      const output = yield* run(Effect.flatMap(Jj, (jj) => jj.status()), realSpawner)
      expect(output).toBe("the working copy is clean\n")
    }))

  it.effect("passes the working directory through to the spawned command", () =>
    Effect.gen(function*() {
      // The shim prints its ACTUAL working directory, so this cell goes red
      // the moment `viaSpawner` stops forwarding the cwd — a fixed scripted
      // answer would keep passing with the forwarding deleted.
      const root = yield* run(Effect.flatMap(Jj, (jj) => jj.root!(directory)), realSpawner)
      // Trimmed, exactly as the self-spawning layer trims it. `pwd` resolves
      // macOS's /var symlink, so compare against the real path.
      expect(root).toBe(realpathSync(directory))
    }))

  it.effect("runs root(from) in its argument directory, not the bound root", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "flows-jj-spawner-bound-"))),
      (bound) =>
        Effect.gen(function*() {
          // `root`'s argument names the directory jj must run in, so a bound
          // layer deliberately does not redirect it — the shim answers with
          // the directory the child actually ran in.
          const root = yield* Effect.flatMap(Jj, (jj) => jj.root!(directory)).pipe(
            Effect.provide(Layer.provide(budgeted(NodeJj.layerSpawnerAt(bound)), realSpawner))
          )

          expect(root).toBe(realpathSync(directory))
          expect(root).not.toBe(realpathSync(bound))
        }),
      (bound) => Effect.sync(() => rmSync(bound, { recursive: true, force: true }))
    ))

  it.effect("builds a repository-bound adapter over the host spawner", () =>
    Effect.gen(function*() {
      const output = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(
        Effect.provide(Layer.provide(budgeted(NodeJj.layerSpawnerAt(directory)), realSpawner))
      )

      expect(output).toBe("the working copy is clean\n")
    }))

  it.effect.skipIf(!jjInstalled)(
    "snapshots and restores the bound repository through the host spawner, leaving a second repository untouched",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const bound = mkdtempSync(join(tmpdir(), "flows-jj-spawner-bound-"))
          const other = mkdtempSync(join(tmpdir(), "flows-jj-spawner-other-"))
          execFileSync("jj", ["git", "init", bound], { stdio: "ignore" })
          execFileSync("jj", ["git", "init", other], { stdio: "ignore" })
          writeFileSync(join(bound, "tracked.txt"), "first\n")
          writeFileSync(join(other, "tracked.txt"), "other\n")
          return { bound, other }
        }),
        ({ bound, other }) =>
          Effect.gen(function*() {
            // The resolver must find the REAL jj, not the scripted stand-in
            // this suite's beforeEach points SMITHERS_JJ_PATH at.
            delete process.env.SMITHERS_JJ_PATH
            const spawner = spawnerWithPath(process.env.PATH ?? "")
            const layer = Layer.provide(budgeted(NodeJj.layerSpawnerAt(bound)), spawner)
            const current = (cwd: string) =>
              execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"], {
                cwd,
                encoding: "utf8"
              })
            const otherBefore = current(other)

            const { commitId } = yield* Effect.flatMap(Jj, (jj) => jj.snapshot("bound snapshot")).pipe(
              Effect.provide(layer)
            )
            writeFileSync(join(bound, "tracked.txt"), "second\n")
            yield* Effect.flatMap(Jj, (jj) => jj.restore(commitId)).pipe(Effect.provide(layer))

            // The bound repository was snapshotted and restored. If the
            // spawner dropped the bound cwd, jj would have run in the CALLER's
            // directory instead, and this file would still hold the second
            // write — the shim cannot fake its way past a real repository.
            expect(readFileSync(join(bound, "tracked.txt"), "utf8")).toBe("first\n")
            // And nothing the layer ran leaked into the other repository.
            expect(readFileSync(join(other, "tracked.txt"), "utf8")).toBe("other\n")
            expect(current(other)).toBe(otherBefore)
          }),
        ({ bound, other }) =>
          Effect.sync(() => {
            rmSync(bound, { recursive: true, force: true })
            rmSync(other, { recursive: true, force: true })
          })
      )
  )

  it.effect("classifies a nonzero exit from jj's own stderr vocabulary", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("a", "b"))), realSpawner)
      expect(error.code).toBe("invalid_ref")
      expect(error.message).toBe("jj diff: Error: Revision not found")
    }))

  it.effect("reports a jj the host cannot find as `not_installed`", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(run(Effect.flatMap(Jj, (jj) => jj.status()), missingBinary()))
      expect(error.code).toBe("not_installed")
      expect(error.message).toBe("jj: command not found on PATH")
    }))

  it.effect("carries an unusable environment override's hint into a host spawn failure", () =>
    Effect.gen(function*() {
      process.env.SMITHERS_JJ_PATH = overrideBinary
      chmodSync(overrideBinary, 0o644)
      try {
        const error = yield* Effect.flip(run(Jj, missingBinary()))
        expect(error.code).toBe("not_installed")
        expect(error.message).toContain(`jj: Cannot execute the jj binary at ${overrideBinary}.`)
        expect(error.message).toContain(`chmod +x '${overrideBinary}'`)
        expect(error.message).toContain("or point SMITHERS_JJ_PATH at a working jj.")
      } finally {
        chmodSync(overrideBinary, 0o755)
      }
    }))

  it.effect("spawns the binary SMITHERS_JJ_PATH names, through the spawner too", () =>
    Effect.gen(function*() {
      // The spawner hands the child `PATH=directory`, where the scripted `jj`
      // lives, so the only way this answer can come back is the override being
      // the command that was spawned.
      process.env.SMITHERS_JJ_PATH = overrideBinary
      try {
        expect(yield* run(Effect.flatMap(Jj, (jj) => jj.status()), realSpawner))
          .toBe("answered by the override\n")
      } finally {
        delete process.env.SMITHERS_JJ_PATH
      }
    }))

  it.effect("names a bound repository root that is not a directory", () =>
    Effect.gen(function*() {
      // A spawner reports a missing binary and an unusable working directory
      // the same way, so without the directory probe a bound layer pointed at a
      // directory that is gone answers `not_installed` with jj on PATH.
      const missing = join(directory, "absent-root")
      const error = yield* Effect.flip(Effect.provide(
        Effect.flatMap(Jj, (jj) => jj.status()),
        Layer.provide(budgeted(NodeJj.layerSpawnerAt(missing)), missingBinary(true))
      ))

      expect(error.code).toBe("unknown")
      expect(error.message).toBe(`jj status: cannot run in ${missing}: not a directory`)
    }))

  it.effect("refuses output past the same ceiling the self-spawning layer applies", () =>
    Effect.gen(function*() {
      // `Stream.mkString` is as unbounded as string concatenation, so without a
      // bound this layer would buffer what `NodeJj.layer` refuses — a behavior
      // difference bought by the containment routing, which is the one thing
      // routing through a spawner must not cost.
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())), flood)

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: output exceeded the 67108864-byte ceiling")
      expect(error).toMatchObject({
        module: "NodeJj",
        method: "status",
        command:
          "jj status --color=never --config snapshot.max-new-file-size=0 --config signing.behavior=drop --config signing.backends.gpg.program=/dev/null --config signing.backends.gpgsm.program=/dev/null --config signing.backends.ssh.program=/dev/null --config fsmonitor.backend=none"
      })
    }))

  it.effect("reports any other spawn failure as `unknown`", () =>
    Effect.gen(function*() {
      const refused = Layer.effect(
        ChildProcessSpawner,
        Effect.map(ChildProcessSpawner, (real) =>
          makeSpawner((command) =>
            (command as EffectChildProcess.StandardCommand).args.includes("--version")
              ? real.spawn(command)
              : Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "ChildProcess",
                  method: "spawn",
                  description: "jj"
                })
              )
          ))
      ).pipe(Layer.provide(realSpawner))
      const error = yield* Effect.flip(run(
        Effect.flatMap(Jj, (jj) =>
          jj.status()),
        refused
      ))
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("jj status:")
    }))
})

describe("NodeJj repository-root validation", () => {
  it("refuses relative roots for both process ownership modes", () => {
    expect(() => NodeJj.layerAt("relative/repository")).toThrow(
      "NodeJj.layerAt requires an absolute repository root"
    )
    expect(() => NodeJj.layerSpawnerAt("relative/repository")).toThrow(
      "NodeJj.layerSpawnerAt requires an absolute repository root"
    )
  })
})
