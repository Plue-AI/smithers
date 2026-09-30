import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Cleanup from "../src/internal/ProcessCleanup.ts"
import { ProcessCleanupPolicyError } from "../src/internal/ProcessCleanupPolicyError.ts"
import { bootstrapArguments, failure } from "../src/internal/ProcessSupervisor.ts"

describe("prepared process policy", () => {
  it.effect("isolates ordinary runtimes and refuses compiled application recursion", () =>
    Effect.gen(function*() {
      expect(yield* bootstrapArguments({ bun: false, main: "", sea: false })).toEqual([])
      expect(yield* bootstrapArguments({ bun: true, main: "/app/entry.ts", sea: false }))
        .toEqual(["--no-env-file", "--config=/dev/null"])
      for (
        const runtime of [
          { bun: false, main: "", sea: true },
          { bun: true, main: "/$bunfs/root/app.ts", sea: false }
        ]
      ) {
        const result = yield* Effect.exit(bootstrapArguments(runtime))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(false)
      }
    }))
  it.effect("resolves defaults, duration inputs and explicit zero grace", () =>
    Effect.gen(function*() {
      expect(yield* Cleanup.policy({})).toEqual({ killSignal: "SIGTERM", graceMs: 2000 })
      expect(yield* Cleanup.policy({}, { killSignal: "SIGINT", forceKillAfter: "3 seconds" }))
        .toEqual({ killSignal: "SIGINT", graceMs: 3000 })
      expect(yield* Cleanup.policy({ killSignal: "SIGKILL", forceKillAfter: 0 }, { forceKillAfter: 20 }))
        .toEqual({ killSignal: "SIGKILL", graceMs: 0 })
    }))

  for (
    const options of [
      { killSignal: "SIGSTOP" },
      { killSignal: "SIGINVALID" },
      { forceKillAfter: Number.POSITIVE_INFINITY },
      { forceKillAfter: -1 },
      { forceKillAfter: 2_147_483_648 },
      { forceKillAfter: "not a duration" }
    ]
  ) {
    it.effect(`refuses invalid policy through the typed error channel: ${JSON.stringify(options)}`, () =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(Cleanup.policy(options as ChildProcess.KillOptions))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.hasDies(result.cause)).toBe(false)
          expect(Cause.hasFails(result.cause)).toBe(true)
        }
      }))
  }

  for (
    const [options, code] of [
      [{ killSignal: "SIGSTOP" }, "kill_signal_unsupported"],
      [{ killSignal: "SIGINVALID" }, "kill_signal_unsupported"],
      [{ forceKillAfter: Number.POSITIVE_INFINITY }, "grace_out_of_range"],
      [{ forceKillAfter: -1 }, "grace_out_of_range"],
      [{ forceKillAfter: 2_147_483_648 }, "grace_out_of_range"]
    ] as const
  ) {
    it.effect(`reports ${code} as a tagged cause of the platform error: ${JSON.stringify(options)}`, () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Cleanup.policy(options as ChildProcess.KillOptions))
        expect(error.cause).toBeInstanceOf(ProcessCleanupPolicyError)
        expect(error.cause).toMatchObject({ _tag: "@smthrs/platform-node/ProcessCleanupPolicyError", code })
      }))
  }

  for (
    const [code, tag] of [
      ["ENOENT", "NotFound"],
      ["EACCES", "PermissionDenied"],
      ["EEXIST", "AlreadyExists"],
      ["EISDIR", "BadResource"],
      ["ENOTDIR", "BadResource"],
      ["ELOOP", "BadResource"],
      ["EBUSY", "Busy"],
      ["other", "Unknown"]
    ]
  ) {
    it(`preserves native ${code} as ${tag}`, () => {
      const error = failure("spawn", "/command", {
        code,
        syscall: "spawn /command",
        errno: -2,
        message: "native failure"
      })
      expect(error.reason).toMatchObject({
        _tag: tag,
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: "/command",
        syscall: "spawn /command",
        cause: { code, errno: -2, message: "native failure" }
      })
    })
  }
  it("keeps existing errors and actual signal causes", () => {
    const cause = Object.assign(new Error("stopped"), { signal: "SIGINT" })
    expect(failure("exitCode", "command", cause).reason).toMatchObject({ cause })
    expect(failure("spawn", "command", null).reason).toMatchObject({
      _tag: "Unknown",
      cause: { message: "The process supervisor failed" }
    })
  })
})
