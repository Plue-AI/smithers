/**
 * The command, run in process with an argument list.
 *
 * `test/flow/Bin.test.ts` spawns the built executable, which is what an
 * operator runs and the only way to observe `runMain`. This file runs the
 * same command through `Command.runWith` inside the test process, where every
 * branch of the handler is measured: the flag decoding, the refused gate, the
 * rendering, and the exit status it leaves in `process.exitCode`.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Cli from "@smthrs/migrate/flow/Cli"
import * as Lock from "@smthrs/migrate/flow/Lock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CliConfig, Command } from "effect/unstable/cli"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, vi } from "vitest"
import { copyFixture, hashTree } from "../fixtures/helpers.ts"

beforeEach(() => vi.stubEnv("AI_GATEWAY_API_KEY", ""))
afterEach(() => vi.unstubAllEnvs())

const services = Layer.mergeAll(NodeServices.layer, CliConfig.layer())

/** Runs the command and returns the exit status it set, leaving the process's own status untouched. */
const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const previous = process.exitCode
    process.exitCode = undefined
    try {
      yield* Command.runWith(Cli.command, { version: Cli.version })(args)
      return process.exitCode ?? 0
    } finally {
      process.exitCode = previous
    }
  }).pipe(Effect.provide(services))

describe("the smithers-migrate command in process", () => {
  it.live("plans by default and exits 0 with the report written", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const status = yield* run(["--root", root, "--report-dir", ".out"])

      expect(status).toBe(0)
      expect(existsSync(join(root, ".out", "report.md"))).toBe(true)
      expect(existsSync(join(root, ".out", "report.json"))).toBe(true)
    }))

  it.live("scans without writing a byte, JSON rendering included", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      const status = yield* run(["--root", root, "--scan", "--json"])

      expect(status).toBe(0)
      expect(hashTree(root)).toEqual(before)
    }))

  it.live("parks a keyless apply over run state with exit 3 and touches nothing", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const before = hashTree(root)

      const status = yield* run(["--root", root, "--apply", "--report-dir", ".out"])

      expect(status).toBe(3)
      expect(hashTree(root)).toEqual(before)
    }))

  it.live("parks a keyless apply at its live lock and touches nothing", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // Held by this process, which is alive: exactly what a concurrent apply
      // in another process looks like to the lock.
      yield* Effect.acquireUseRelease(
        Lock.acquire({ root, reportDir: ".out" }),
        () =>
          Effect.gen(function*() {
            const before = hashTree(root)
            // Startup refuses before inspecting the lock or creating a backup.
            const status = yield* run(["--root", root, "--apply", "--allow-no-vcs", "--report-dir", ".out"])

            expect(status).toBe(3)
            expect(hashTree(root)).toEqual(before)
          }),
        Lock.release
      ).pipe(Effect.provide(NodeServices.layer))
    }))

  it.live("refuses a report directory that could leave the project with exit 1", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      const status = yield* run(["--root", root, "--report-dir", "../escape"])

      expect(status).toBe(1)
      expect(hashTree(root)).toEqual(before)
    }))

  it.live("takes every verification override and the empty typecheck", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const status = yield* run([
        "--root",
        root,
        "--report-dir",
        ".out",
        "--verify-install",
        "make deps",
        "--verify-format",
        "make fmt",
        "--verify-typecheck",
        "",
        "--verify-test",
        "make test",
        "--allow-unsafe",
        "UI,Worktree",
        "--unit",
        "dependencies,project",
        "--max-repair-rounds",
        "1",
        "--flows-dir",
        "src/flows",
        "--keep-old-sources",
        "--allow-no-vcs",
        "--acknowledge-run-state",
        "--seat",
        "anthropic:some-model"
      ])

      expect(status).toBe(0)
    }))
})
