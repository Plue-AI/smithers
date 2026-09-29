/**
 * Telling an invalid probe from a failing check. A zero exit needs no judge;
 * every non-zero exit needs attribution, including shell-reserved codes.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Result } from "effect"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Probe from "../src/Probe.ts"

/** An evaluator that answers one attribution, with the confidence it is given. */
const answering = (
  attribution: string,
  probability: number,
  options?: { readonly executed?: boolean }
): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerScripted((request) => {
    const options_ = Object.keys(
      (request.questions["attribution"] as { readonly criteria: Record<string, string> }).criteria
    )
    const rest = (1 - probability) / (options_.length - 1)
    return {
      attribution: {
        choice: attribution,
        probabilities: Object.fromEntries(
          options_.map((option) => [option, option === attribution ? probability : rest])
        )
      },
      executed: { probability: options?.executed === true ? 0.95 : 0.05 }
    }
  })

const refusing = (code: Evaluator.EvaluatorErrorCode): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerScripted(() =>
    Effect.fail(new Evaluator.EvaluatorError({ code, message: `The gateway answered ${code}` }))
  )

const classify = (
  result: { readonly command?: string; readonly exitCode: number; readonly output?: string },
  layer: Layer.Layer<Evaluator.Evaluator> = answering("tree", 0.9)
) =>
  Effect.runPromise(
    Probe.classify({
      command: result.command ?? "python -m pytest -rA",
      exitCode: result.exitCode,
      output: result.output ?? ""
    }).pipe(Effect.result, Effect.provide(layer))
  )

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`Expected a success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`Expected a failure, got ${JSON.stringify(result.success)}`)
  return result.failure
}

describe("Probe.classify", () => {
  it("never asks about a command that exited zero, whatever it printed", async () => {
    const asked: Array<unknown> = []
    const recording = Evaluator.layerScripted((request) => {
      asked.push(request.state)
      return { attribution: { choice: "unknown-module" }, executed: { probability: 0.1 } }
    })
    expect(
      success(await classify({ exitCode: 0, output: "ModuleNotFoundError: No module named 'nope'" }, recording))
    ).toEqual({ to: "tree" })
    expect(asked).toEqual([])
  })

  it.each([127, 126])("asks the judge about exit %i rather than treating it as a launch failure", async (exitCode) => {
    const asked: Array<unknown> = []
    const recording = Evaluator.layerScripted((request) => {
      asked.push(request.state)
      return { attribution: { choice: "tree" }, executed: { probability: 0.9 } }
    })
    const attribution = success(await classify({ exitCode, output: "not ok 1 - actual assertion" }, recording))
    expect(attribution.to).toBe("tree")
    expect(attribution.invalidProbe).toBeUndefined()
    expect(asked).toHaveLength(1)
  })

  it.each(
    [
      "unknown-command",
      "unknown-test",
      "unknown-path",
      "unknown-module",
      "unknown-environment"
    ] as const
  )("reports %s when the judge is decisive about it", async (reason) => {
    const attribution = success(await classify({ exitCode: 1 }, answering(reason, 0.93)))
    expect(attribution.to).toBe(reason)
    expect(attribution.invalidProbe?.reason).toBe(reason)
    expect(attribution.invalidProbe?.evidence).toContain("confidence 0.93")
    expect(attribution.invalidProbe?.message).toContain("never ran a check")
    expect(attribution.invalidProbe?.message).toContain("not a reproduction")
  })

  it("leaves the failure with the tree when the judge says the tree", async () => {
    const attribution = success(
      await classify(
        { exitCode: 1, output: "1 failed, 412 passed in 3.20s" },
        answering("tree", 0.97, { executed: true })
      )
    )
    expect(attribution).toEqual({ to: "tree", executed: true })
  })

  it("leaves the failure with the tree when the judge is not sure, and reports what it read", async () => {
    // Below the floor the judge has not decided. The reading that costs a
    // reader nothing it had is the tree's; a false invalid probe tells it its
    // reproduction proved nothing.
    const attribution = success(
      await classify({ exitCode: 1 }, answering("unknown-module", Probe.CONFIDENCE_FLOOR - 0.01, { executed: true }))
    )
    expect(attribution).toEqual({ to: "tree", executed: true })
    expect(Probe.CONFIDENCE_FLOOR).toBe(0.7)
  })

  it("takes an attribution exactly at the floor", async () => {
    const attribution = success(await classify({ exitCode: 1 }, answering("unknown-test", Probe.CONFIDENCE_FLOOR)))
    expect(attribution.to).toBe("unknown-test")
  })

  it("says so when the judge attributed the failure although a runner reported a tally", async () => {
    const attribution = success(
      await classify(
        { exitCode: 1, output: "1 failed, 2 passed\nERROR: not found: t.py::x" },
        answering("unknown-test", 0.88, { executed: true })
      )
    )
    expect(attribution.executed).toBe(true)
    expect(attribution.invalidProbe?.evidence).toContain("also reported that it ran tests")
  })

  it("sends the command, the exit code and the newest output bytes, and nothing else", async () => {
    const seen: Array<Record<string, unknown>> = []
    const recording = Evaluator.layerScripted((request) => {
      seen.push(request.state as Record<string, unknown>)
      return { attribution: { choice: "tree" }, executed: { probability: 0.9 } }
    })
    const output = `${"padding\n".repeat(6_000)}ERROR: file or directory not found: tests/absent.py`
    await classify({ command: "pytest tests/absent.py", exitCode: 4, output }, recording)
    expect(Object.keys(seen[0]!)).toEqual(["command", "exitCode", "output"])
    expect(seen[0]?.["command"]).toBe("pytest tests/absent.py")
    expect(seen[0]?.["exitCode"]).toBe(4)
    const sent = seen[0]?.["output"] as string
    expect(new TextEncoder().encode(sent).byteLength).toBeLessThanOrEqual(Probe.MAX_OUTPUT_BYTES)
    expect(sent).toContain("tests/absent.py")
    expect(Probe.MAX_OUTPUT_BYTES).toBe(32 * 1024)
  })

  it.each(
    [
      ["unreachable", "provider_unavailable"],
      ["refused", "provider_unavailable"],
      ["empty", "provider_unavailable"],
      ["timeout", "timeout"],
      ["invalid_answer", "request_failed"],
      ["invalid_question", "request_failed"]
    ] as const
  )("fails typed when the judge answers %s, and reports no reason", async (code, expected) => {
    const error = failure(await classify({ exitCode: 1 }, refusing(code)))
    expect(Probe.unjudged(error).code).toBe(expected)
    expect(Probe.unjudged(error).message).toContain(code)
    expect(Probe.unjudged(error).message).toContain("subscription seat")
  })

  it("fails rather than guessing when no evaluator is installed", async () => {
    const error = failure(await classify({ exitCode: 1 }, Evaluator.layerUnavailable()))
    expect(error.code).toBe("unreachable")
    expect(Probe.unjudged(error).code).toBe("provider_unavailable")
  })

  it("names the reserved output key flows report under", () => {
    expect(Probe.key).toBe("invalidProbe")
  })
})

describe("the probe/attribution classifier", () => {
  it("offers the tree beside every reason, and asks whether tests ran", () => {
    expect(Probe.probeAttribution.id).toBe("probe/attribution")
    expect(Object.keys(Probe.probeAttribution.questions)).toEqual(["attribution", "executed"])
    expect(Object.keys(Probe.probeAttribution.questions.attribution.criteria)).toEqual([
      "tree",
      ...Probe.Reason.literals
    ])
    for (const question of Object.values(Probe.probeAttribution.questions)) {
      expect(question.instructions).toMatch(/^[A-Z].*\?$/)
      expect(question.instructions).not.toContain(" and ")
    }
  })
})
describe("real shell exit attribution", () => {
  it.each([126, 127])("keeps a launched failing check exiting %i as executed evidence", async (code) => {
    const dir = mkdtempSync(join(tmpdir(), "probe-exit-"))
    try {
      const file = join(dir, "example.test.mjs")
      writeFileSync(
        file,
        "import { test } from \"node:test\"; import { strict as assert } from \"node:assert\"; test(\"actual assertion\", () => assert.equal(1, 2));"
      )
      const command = `node --test --test-reporter=tap "${file}" || exit ${code}`
      const run = spawnSync("sh", ["-c", command], { encoding: "utf8" })
      expect(run.status).toBe(code)
      expect(run.stdout).toContain("not ok 1 - actual assertion")
      const observed: Array<unknown> = []
      const judge = Evaluator.layerScripted((request) => {
        observed.push(request.state)
        return { attribution: { choice: "tree" }, executed: { probability: 0.95 } }
      })
      const attribution = success(
        await classify({
          command,
          exitCode: run.status!,
          output: run.stdout + run.stderr
        }, judge)
      )
      expect(attribution).toMatchObject({ to: "tree", executed: true })
      expect(attribution.invalidProbe).toBeUndefined()
      expect(observed).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ["missing", 127],
    ["non-executable", 126]
  ])("asks for attribution on a real %s program", async (kind, code) => {
    const dir = mkdtempSync(join(tmpdir(), "probe-exit-"))
    try {
      const file = join(dir, "command")
      if (kind === "non-executable") {
        writeFileSync(file, "#!/bin/sh\nexit 0\n")
        chmodSync(file, 0o644)
      }
      const command = `"${file}"`
      const run = spawnSync("sh", ["-c", command], { encoding: "utf8" })
      expect(run.status).toBe(code)
      expect(run.stderr).toMatch(/not found|No such file or directory|Permission denied/)
      const observed: Array<unknown> = []
      const judge = Evaluator.layerScripted((request) => {
        observed.push(request.state)
        return { attribution: { choice: "unknown-command" }, executed: { probability: 0.05 } }
      })
      const attribution = success(
        await classify({
          command,
          exitCode: run.status!,
          output: run.stdout + run.stderr
        }, judge)
      )
      expect(attribution.to).toBe("unknown-command")
      expect(attribution.invalidProbe?.reason).toBe("unknown-command")
      expect(observed).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
