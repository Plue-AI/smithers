/**
 * `NodeJj`'s error surface, driven against a stand-in `jj` on `PATH`.
 *
 * A real repository cannot produce every failure vocabulary on demand — jj
 * reports conflicts, missing revisions, and signal deaths under conditions a
 * test cannot reliably stage. The classification is the contract, so the binary
 * is scripted instead and the service is exercised end to end through it.
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJjError, Jj, type JjError } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
case "$FLOWS_FAKE_JJ" in
  refused) echo "Warning: Refused to snapshot some files:" 1>&2; echo "  artifact.bin: 2.0MiB (2097152 bytes); the maximum size allowed is 1.0MiB (1048576 bytes)" 1>&2; exit 0 ;;
  conflict) echo "Error: would leave conflicts in note.txt" 1>&2; exit 1 ;;
  revision-not-found) echo "Error: Revision not found" 1>&2; exit 1 ;;
  path-doesnt-exist) echo "Error: Path doesn't exist" 1>&2; exit 1 ;;
  revision-doesnt-exist) echo 'Error: Revision "conflict-fix" doesn'"'"'t exist' 1>&2; exit 1 ;;
  conflict-named-path) echo "Error: Path doesn't exist: docs/conflict-resolution.md" 1>&2; exit 1 ;;
  chained-conflict) printf 'Error: Failed to update the working copy\nCaused by: The merge would leave conflicts\n' 1>&2; exit 1 ;;
  revset-parse) echo "Error: Failed to parse revset: Syntax error" 1>&2; exit 1 ;;
  stdout-only) echo "Error: reported on stdout"; exit 1 ;;
  silent-exit) exit 3 ;;
  utf8-split) printf 'caf\\303'; /bin/sleep 0.2; printf '\\251 au lait\\n'; exit 0 ;;
  flood) echo $$ > "$FLOWS_FAKE_JJ_MARKER.pid"
    line=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    line="$line$line$line$line"; line="$line$line$line$line"
    line="$line$line$line$line"; line="$line$line$line$line"
    while :; do printf '%s' "$line"; done ;;
  signal) kill -9 $$ ;;
  slow) echo $$ > "$FLOWS_FAKE_JJ_MARKER.pid"; : > "$FLOWS_FAKE_JJ_MARKER.started"; /bin/sleep 1; : > "$FLOWS_FAKE_JJ_MARKER" ;;
  orphan) echo $$ > "$FLOWS_FAKE_JJ_MARKER.pid"
    (: > "$FLOWS_FAKE_JJ_MARKER.started"; /bin/sleep 1; : > "$FLOWS_FAKE_JJ_MARKER") & exit 0 ;;
  *) exit 0 ;;
esac
`

/**
 * Poll for a marker file rather than sleeping a fixed span: a fixed wait is
 * sized against an unloaded machine and turns spawn latency into a red suite
 * (issue #170).
 */
const waitFor = (path: string) =>
  Effect.retry(
    Effect.suspend(() => existsSync(path) ? Effect.void : Effect.fail("absent" as const)),
    { times: 300, schedule: Schedule.spaced(10) }
  )

/**
 * Poll until `pid` is no longer a live process.
 *
 * Process liveness is the positive signal that Node has reaped the direct child
 * and populated its exit state. It works for both an interrupted process and a
 * process whose descendant keeps the pipes open after the direct child exits.
 */
const waitForExit = (pid: number) =>
  Effect.retry(
    Effect.suspend(() => {
      try {
        process.kill(pid, 0)
        return Effect.fail("alive" as const)
      } catch {
        return Effect.void
      }
    }),
    { times: 500, schedule: Schedule.spaced(10) }
  )

let directory: string

const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, budgeted(NodeJj.layerAt(directory)))

/** `Jj`'s channel names the kernel's failures too; an undecorated layer produces only jj's own. */
const asJjError = (error: unknown): JjError => {
  if (!isJjError(error)) throw new Error(`expected a JjError from an undecorated host layer, got ${String(error)}`)
  return error
}

const status = (mode: string) => {
  process.env.FLOWS_FAKE_JJ = mode
  return run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
}

describe.skipIf(process.platform === "win32")("NodeJj failure classification", () => {
  let previousPath: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-fake-jj-"))
    await writeFile(join(directory, "jj"), script)
    await chmod(join(directory, "jj"), 0o755)

    previousPath = process.env.PATH
    process.env.PATH = directory
    // The adapter honours SMITHERS_JJ_PATH, so a developer who has one set
    // would otherwise run their own jj instead of the scripted fake.
    delete process.env.SMITHERS_JJ_PATH
    delete process.env.FLOWS_JJ_PATH
  })

  afterAll(async () => {
    process.env.PATH = previousPath
    delete process.env.FLOWS_FAKE_JJ
    delete process.env.FLOWS_FAKE_JJ_MARKER
    delete process.env.SMITHERS_JJ_PATH
    await rm(directory, { recursive: true, force: true })
  })

  it.live("fails typed when a successful command warns that files were refused", () =>
    Effect.gen(function*() {
      const error = yield* status("refused")
      expect(error.code).toBe("snapshot_refused")
      expect(error.message).toContain("artifact.bin")
      expect(asJjError(error).command).toBe(
        "jj status --color=never --config snapshot.max-new-file-size=0 --config signing.behavior=drop --config signing.backends.gpg.program=/dev/null --config signing.backends.gpgsm.program=/dev/null --config signing.backends.ssh.program=/dev/null --config fsmonitor.backend=none"
      )
    }))

  it.live("classifies conflict vocabulary as `conflict`", () =>
    Effect.gen(function*() {
      const error = yield* status("conflict")

      expect(error.code).toBe("conflict")
      expect(error.message).toBe("jj status: Error: would leave conflicts in note.txt")
    }))

  it.live("classifies `revision not found` as `invalid_ref`", () =>
    Effect.gen(function*() {
      expect((yield* status("revision-not-found")).code).toBe("invalid_ref")
    }))

  it.live("classifies a REVISION that doesn't exist as `invalid_ref`, ahead of the conflict vocabulary", () =>
    Effect.gen(function*() {
      // `Error: Revision "conflict-fix" doesn't exist` is the case a bare
      // `includes("conflict")`, tested first, read as a conflicted repository.
      // `invalid_ref` is the durable code a journal has to carry for it.
      const error = yield* status("revision-doesnt-exist")

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("conflict-fix")
    }))

  it.live("does not read a PATH diagnostic as a missing revision", () =>
    Effect.gen(function*() {
      // `Jj.ts` defines `invalid_ref` as "the change id or revision does not
      // resolve". A missing path is not one, so it stays `unknown`.
      expect((yield* status("path-doesnt-exist")).code).toBe("unknown")
    }))

  it.live("does not read a path that merely contains the word conflict as a conflict", () =>
    Effect.gen(function*() {
      expect((yield* status("conflict-named-path")).code).toBe("unknown")
    }))

  it.live("reads the conflict half of an error chain, not only its first line", () =>
    Effect.gen(function*() {
      // jj prints `Error: <top>` then `Caused by: <inner>`, and the conflict
      // wording is usually the inner line, so anchoring only on `Error:` would
      // journal a real conflict as `unknown`.
      expect((yield* status("chained-conflict")).code).toBe("conflict")
    }))

  it.live("classifies `failed to parse revset` as `invalid_ref`, agreeing with the wasm layer", () =>
    Effect.gen(function*() {
      expect((yield* status("revset-parse")).code).toBe("invalid_ref")
    }))

  it.live("classifies empty revisions as `invalid_ref` before any spawn", () =>
    Effect.gen(function*() {
      process.env.FLOWS_FAKE_JJ = "ok" // the fake would exit 0: proof no spawn happened
      const restoreError = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore(""))))
      expect(restoreError.code).toBe("invalid_ref")
      expect(restoreError.message).toBe("jj restore: empty revision string")
      // Refusing before the spawn is not a reason to drop the metadata: the
      // command is the one the operation would have run, so every failure this
      // adapter produces can be attributed the same way.
      expect(restoreError).toMatchObject({ module: "NodeJj", method: "restore", command: "jj restore" })
      const diffError = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("@", ""))))
      expect(diffError.code).toBe("invalid_ref")
      expect(diffError.message).toBe("jj diff: empty revision string")
      expect(asJjError(diffError).command).toBe("jj diff")
      const addError = yield* run(
        Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("lane", "/tmp/lane", "")))
      )
      expect(addError).toMatchObject({ method: "workspaceAdd", command: "jj workspace add" })
      const revertError = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.revert!(""))))
      expect(revertError).toMatchObject({ method: "revert", command: "jj revert" })
    }))

  it.live("falls back to stdout for the message when stderr is empty", () =>
    Effect.gen(function*() {
      const error = yield* status("stdout-only")

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: Error: reported on stdout")
    }))

  it.live("names the signal that killed a `jj` with nothing to report", () =>
    Effect.gen(function*() {
      // A silent child killed by the OS or an operator used to journal
      // `jj status: ` — an empty diagnosis for the failure mode that most
      // needs one, because there is no stderr to classify.
      const error = yield* status("signal")

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: terminated by signal SIGKILL")
    }))

  it.live("names the exit code of a `jj` that failed with nothing to report", () =>
    Effect.gen(function*() {
      // The other empty-stream failure: no signal, no stderr, just a code.
      // Without the fallback this journaled the same empty `jj status: ` a
      // signal death did, and the two could not be told apart.
      const error = yield* status("silent-exit")

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: exited with code 3")
    }))

  it.live("succeeds and returns stdout when the command exits zero", () =>
    Effect.gen(function*() {
      process.env.FLOWS_FAKE_JJ = "ok"

      expect(yield* run(Effect.flatMap(Jj, (jj) => jj.status()))).toBe("")
    }))

  it.live("decodes a code point split across two chunks instead of corrupting it", () =>
    Effect.gen(function*() {
      // The fake writes `caf` plus the FIRST byte of `é`, waits, then writes the
      // second byte. Decoding each chunk on its own turns one code point into
      // two replacement characters, in a diff or a status a run then journals.
      // `layerSpawner` never had the bug because `Stream.decodeText` carries
      // partial sequences across chunks, and the two layers must not disagree.
      process.env.FLOWS_FAKE_JJ = "utf8-split"

      expect(yield* run(Effect.flatMap(Jj, (jj) => jj.status()))).toBe("café au lait\n")
    }))

  it.live("spawns the binary SMITHERS_JJ_PATH names rather than searching PATH", () =>
    Effect.gen(function*() {
      // `smithers doctor` prints the override as the jj this host runs, so it
      // has to be the file that actually runs: PATH holds no jj at all here.
      const path = process.env.PATH
      process.env.PATH = join(directory, "empty-bin")
      process.env.SMITHERS_JJ_PATH = join(directory, "jj")
      process.env.FLOWS_FAKE_JJ = "stdout-only"
      try {
        const error = yield* status("stdout-only")

        expect(error.code).toBe("unknown")
        expect(error.message).toBe("jj status: Error: reported on stdout")
      } finally {
        process.env.PATH = path
        delete process.env.SMITHERS_JJ_PATH
      }
    }))

  it.live("names the working directory rather than blaming a missing jj", () =>
    Effect.gen(function*() {
      // `spawn(jj, { cwd })` reports a MISSING cwd as ENOENT, exactly as it
      // reports a missing binary, so a bound layer pointed at a directory that
      // is gone used to answer `not_installed` with jj sitting on PATH.
      const missing = join(directory, "gone")
      const error = yield* Effect.flip(
        Effect.provide(Effect.flatMap(Jj, (jj) => jj.status()), budgeted(NodeJj.layerAt(missing)))
      )

      expect(error.code).toBe("unknown")
      expect(error.message).toBe(`jj status: cannot run in ${missing}: not a directory`)
    }))

  it.live("bounds the command it records so a caller's message cannot ride into the journal", () =>
    Effect.gen(function*() {
      // `command` is journaled with the error and the argv holds whatever the
      // caller passed as a workspace name.
      process.env.FLOWS_FAKE_JJ = "conflict"
      const error = asJjError(
        yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceForget("m".repeat(2000)))))
      )

      expect(error.command!.length).toBeLessThan(600)
      expect(error.command!.endsWith("…")).toBe(true)
      expect(error.command!.startsWith("jj workspace forget")).toBe(true)
    }))

  it.live("names a starting path that is not there when asked for its root", () =>
    Effect.gen(function*() {
      // `root` resolves a FILE to its directory, and a path that is not there
      // at all is passed through so the spawn failure names it rather than
      // reporting a missing jj.
      const missing = join(directory, "no-such-tree")
      const error = asJjError(yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.root!(missing)))))

      expect(error.code).toBe("unknown")
      expect(error.message).toBe(`jj root: cannot run in ${missing}: not a directory`)
    }))

  it.live("keeps a synchronous spawn refusal in the typed channel", () =>
    Effect.gen(function*() {
      // `node:child_process` THROWS for an argument carrying a NUL byte rather
      // than emitting an `error` event, so an unguarded spawn turned a caller's
      // workspace name into a defect no `Jj` caller can catch.
      process.env.FLOWS_FAKE_JJ = "ok"
      const nul = String.fromCharCode(0)
      const error = yield* run(
        Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceForget(`held${nul}name`)))
      )

      expect(error.code).toBe("unknown")
      expect(error.message).toContain("null bytes")
      expect(error).toMatchObject({ module: "NodeJj", method: "workspaceForget" })
    }))

  it.live("stops a child that never stops printing, instead of buffering it", () =>
    Effect.gen(function*() {
      // The engine outlives any one invocation, so an unbounded child is an
      // unbounded buffer in a long-lived process. The fake never exits on its
      // own: it is the ceiling that ends it.
      const marker = join(directory, "flood")
      process.env.FLOWS_FAKE_JJ = "flood"
      process.env.FLOWS_FAKE_JJ_MARKER = marker

      const error = yield* status("flood")

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: output exceeded the 67108864-byte ceiling")
      expect(error).toMatchObject({
        module: "NodeJj",
        method: "status",
        command:
          "jj status --color=never --config snapshot.max-new-file-size=0 --config signing.behavior=drop --config signing.backends.gpg.program=/dev/null --config signing.backends.gpgsm.program=/dev/null --config signing.backends.ssh.program=/dev/null --config fsmonitor.backend=none"
      })
      // Refusing the output is only half the answer: the child has to be gone,
      // not left filling a pipe nobody reads.
      yield* waitForExit(Number(readFileSync(`${marker}.pid`, "utf8").trim()))
    }))

  it.live("kills a still-running `jj` when the fiber is interrupted", () =>
    Effect.gen(function*() {
      const marker = join(directory, "escaped")
      const started = `${marker}.started`
      const pidFile = `${marker}.pid`
      process.env.FLOWS_FAKE_JJ = "slow"
      process.env.FLOWS_FAKE_JJ_MARKER = marker

      // The absence of `marker` only proves the kill worked if the child was
      // demonstrably alive when the interrupt was delivered. Without this
      // positive control a spawn failure or a spawn delayed past the interrupt
      // leaves `marker` trivially absent and the cell passes for the wrong
      // reason (issue #162), so wait for the child's own started marker and
      // assert it immediately before interrupting.
      yield* (
        Effect.gen(function*() {
          const jj = yield* Jj
          const fiber = yield* Effect.forkChild(jj.status(), { startImmediately: true })
          yield* waitFor(started)
          expect(existsSync(started)).toBe(true)
          expect(existsSync(marker)).toBe(false)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(budgeted(NodeJj.layer)))
      )
      // A fixed sleep sized the absence window against an unloaded machine, so a
      // delayed write from an unkilled child could land after the window closed
      // and the cell would pass for the wrong reason (issue #175). Wait for the
      // child process itself to disappear instead: the script writes `marker`
      // before exiting, so once the pid is gone the marker has either been
      // written or never will be, and the absence is a decided fact.
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
      expect(Number.isInteger(pid)).toBe(true)
      yield* (waitForExit(pid))

      expect(existsSync(marker)).toBe(false)
    }))

  it.live("does not signal a `jj` that already exited while its pipes are still held", () =>
    Effect.gen(function*() {
      const marker = join(directory, "orphan-finished")
      const started = `${marker}.started`
      const pidFile = `${marker}.pid`
      process.env.FLOWS_FAKE_JJ = "orphan"
      process.env.FLOWS_FAKE_JJ_MARKER = marker

      // `jj` exits immediately but a background descendant keeps stdout open, so
      // `close` never arrives and the call is still interruptible after the exit.
      //
      // A marker written immediately before shell exit still races Node's exit
      // observation. Wait for the recorded PID to disappear instead: once the
      // direct child has been reaped, `child.exitCode` is populated while the
      // descendant deliberately keeps the callback's pipes open (issue #170).
      yield* (
        Effect.gen(function*() {
          const jj = yield* Jj
          const fiber = yield* Effect.forkChild(jj.status(), { startImmediately: true })
          yield* waitFor(started)
          yield* waitFor(pidFile)
          const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
          expect(Number.isInteger(pid)).toBe(true)
          yield* waitForExit(pid)
          expect(existsSync(started)).toBe(true)
          expect(existsSync(marker)).toBe(false)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(budgeted(NodeJj.layer)))
      )
      yield* (waitFor(marker))

      // Nothing was signalled, so the descendant ran to completion.
      expect(existsSync(marker)).toBe(true)
    }))
})

describe.skipIf(process.platform === "win32")("NodeJj spawn errors", () => {
  let previousPath: string | undefined
  let previousOverride: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-unexecutable-jj-"))
    await writeFile(join(directory, "jj"), script)
    await chmod(join(directory, "jj"), 0o644)
    previousPath = process.env.PATH
    process.env.PATH = directory
    previousOverride = process.env.SMITHERS_JJ_PATH
    process.env.SMITHERS_JJ_PATH = join(directory, "jj")
  })

  afterAll(async () => {
    process.env.PATH = previousPath
    if (previousOverride === undefined) delete process.env.SMITHERS_JJ_PATH
    else process.env.SMITHERS_JJ_PATH = previousOverride
    await rm(directory, { recursive: true, force: true })
  })

  it.live("reports a non-ENOENT spawn failure as `unknown` rather than `not_installed`", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(run(Jj))

      expect(error.code).toBe("unknown")
      expect(error.message).toMatch(/^jj version: /)
    }))
})
