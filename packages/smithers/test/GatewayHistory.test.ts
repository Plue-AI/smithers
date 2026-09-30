/**
 * The history host `smthrs serve` gives its gateway: `Run.Fork` and
 * `Run.Verify` call the same library `smthrs runs fork` and `smthrs runs
 * verify` do, and a refusal reaches the wire with the CLI's code and sentence.
 */
import * as ControlError from "@smthrs/control/ControlError"
import * as RunHistory from "@smthrs/gateway/RunHistory"
import { Cause, Effect, Exit } from "effect"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as GatewayHistory from "../src/history/GatewayHistory.ts"
import type * as Verify from "../src/history/Verify.ts"
import * as Failure from "../src/internal/Failure.ts"

const report: Verify.Report = {
  runId: "run-1",
  verdict: "divergent",
  replayed: [{ stepKeyDigest: "a", action: "verify/first", node: undefined }],
  resumes: { stepKeyDigest: "r" },
  executes: { stepKeyDigest: "c", action: "verify/renamed", node: "n3" },
  notReplayed: [{ stepKeyDigest: "b", action: "verify/second" }]
}

const ports = (overrides: Partial<GatewayHistory.Ports> = {}) => ({
  mutate: vi.fn(async () => ({ runId: "run-1-fork" }) as never),
  verify: vi.fn(async () => report),
  ...overrides
})

describe("GatewayHistory", () => {
  it("forks at the requested frame and lineage with the step edit as the override", async () => {
    const library = ports()
    const history = GatewayHistory.make("/project", {}, library)
    const edit = { stepKeyDigest: "b", result: { text: "edited" } }
    expect(await Effect.runPromise(history.fork({ runId: "run-1", at: 4, lineage: "main", step: edit })))
      .toEqual({ runId: "run-1-fork", parentRunId: "run-1", status: "parked" })
    expect(library.mutate).toHaveBeenCalledWith(
      "/project",
      "run-1",
      { sequence: 4, lineage: "main", override: edit },
      "fork",
      expect.any(AbortSignal)
    )
    await Effect.runPromise(history.fork({ runId: "run-1", at: 0 }))
    expect(library.mutate).toHaveBeenLastCalledWith(
      "/project",
      "run-1",
      { sequence: 0 },
      "fork",
      expect.any(AbortSignal)
    )
  })

  it("verifies within the served bound and drops the fields a step does not name", async () => {
    const library = ports()
    const modules = undefined
    const history = GatewayHistory.make("/project", { modules }, library)
    expect(await Effect.runPromise(history.verify({ runId: "run-1" }))).toEqual({
      runId: "run-1",
      verdict: "divergent",
      replayed: [{ stepKeyDigest: "a", action: "verify/first" }],
      resumes: { stepKeyDigest: "r" },
      executes: { stepKeyDigest: "c", action: "verify/renamed", node: "n3" },
      notReplayed: [{ stepKeyDigest: "b", action: "verify/second" }]
    })
    expect(library.verify).toHaveBeenCalledWith(
      "/project",
      "run-1",
      { settleWithin: GatewayHistory.verifyWithin, modules },
      expect.any(AbortSignal)
    )
  })

  it("omits the resumed and executed steps of a report without them", async () => {
    const consistent: Verify.Report = { runId: "run-2", verdict: "consistent", replayed: [], notReplayed: [] }
    const history = GatewayHistory.make(
      "/project",
      { settleWithin: "5 seconds" },
      ports({ verify: async () => consistent })
    )
    expect(await Effect.runPromise(history.verify({ runId: "run-2" }))).toEqual(consistent)
  })

  it("answers a designed refusal with the CLI's code and redacted sentence", async () => {
    const refusal = new CliError.Refused({
      fault: "user",
      code: "history_missing",
      message: "No execution history; Authorization: Bearer private-fixture"
    })
    const history = GatewayHistory.make(
      "/project",
      {},
      ports({
        mutate: async () => {
          throw refusal
        },
        verify: async () => {
          throw new Error("The path must be a directory")
        }
      })
    )
    const forked = await Effect.runPromise(Effect.flip(history.fork({ runId: "run-1", at: 0 })))
    expect(forked).toMatchObject({ _tag: "@smthrs/gateway/HistoryRefused", code: "history_missing" })
    expect(forked.message).toContain("No execution history")
    expect(forked.message).not.toContain("private-fixture")
    // A plain Error the CLI threw on purpose is designed, but names no code.
    expect(await Effect.runPromise(Effect.flip(history.verify({ runId: "run-1" }))))
      .toMatchObject({ code: "history_failed", message: "The path must be a directory" })
  })

  it("names no host path in a refusal", async () => {
    const history = GatewayHistory.make(
      "/srv/project",
      {},
      ports({
        verify: async () => {
          throw new CliError.Refused({
            fault: "user",
            code: "history_missing",
            message: `No execution history at /srv/project/.flows; scratch ${join(tmpdir(), "smthrs-verify-1")}; ` +
              `config ${join(homedir(), ".config")}`
          })
        }
      })
    )
    expect((await Effect.runPromise(Effect.flip(history.verify({ runId: "run-1" })))).message)
      .toBe("No execution history at ./.flows; scratch <tmp>/smthrs-verify-1; config ~/.config")
  })

  it("keeps a tagged control or store failure's own code", async () => {
    const history = GatewayHistory.make(
      "/project",
      {},
      ports({
        verify: async () => {
          throw new ControlError.RunNotFound({ runId: "run-9" })
        }
      })
    )
    expect(await Effect.runPromise(Effect.flip(history.verify({ runId: "run-9" }))))
      .toMatchObject({ code: "run_not_found", message: expect.stringContaining("run-9") })
  })

  it("serves the same library as the gateway's layer", async () => {
    const served = await Effect.runPromise(
      Effect.gen(function*() {
        return Object.keys(yield* RunHistory.RunHistory).sort()
      }).pipe(
        Effect.provide(GatewayHistory.layer("/project"))
      )
    )
    expect(served).toEqual(["fork", "verify"])
  })

  it("names history_failed for a designed failure with an empty code", async () => {
    const history = GatewayHistory.make(
      "/project",
      {},
      ports({
        verify: async () => {
          throw Object.assign(new Error("The store is locked"), { code: "" })
        }
      })
    )
    expect(await Effect.runPromise(Effect.flip(history.verify({ runId: "run-1" }))))
      .toMatchObject({ code: "history_failed", message: "The store is locked" })
  })

  it("leaves an undesigned failure a defect the gateway reports generically", async () => {
    const bug = new TypeError("cannot read properties of undefined")
    const history = GatewayHistory.make(
      "/project",
      {},
      ports({
        verify: async () => {
          throw bug
        }
      })
    )
    const exit = await Effect.runPromiseExit(history.verify({ runId: "run-1" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(bug)
    expect(Failure.isDesigned(bug)).toBe(false)
  })
})
