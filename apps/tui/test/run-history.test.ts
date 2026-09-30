import * as RunHistory from "@smthrs/gateway/RunHistory"
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import * as History from "../src/run-history.ts"

/*
 * `/verify-run` and `/fork-run` read and fork through the gateway's
 * `RunHistory`: the terminal shows the report `Run.Verify` answers and forks
 * the way `Run.Fork` does, and a refusal is the host's own sentence. `served`
 * speaks the gateway frame a `smthrs serve` answers.
 */

const report: RunHistory.VerifyReport = {
  runId: "run-1",
  verdict: "divergent",
  replayed: [{ stepKeyDigest: "a", action: "verify/first" }, { stepKeyDigest: "n", node: "fetch" }],
  resumes: { stepKeyDigest: "r", node: "review" },
  executes: { stepKeyDigest: "c" },
  notReplayed: [{ stepKeyDigest: "b", action: "verify/second" }, { stepKeyDigest: "d" }]
}

const recording = () => {
  const forks: Array<RunHistory.ForkInput> = []
  const verifies: Array<RunHistory.VerifyInput> = []
  const service: RunHistory.Service = {
    fork: (input) =>
      Effect.sync(() => {
        forks.push(input)
        return { runId: `${input.runId}-fork`, parentRunId: input.runId, status: "parked" as const }
      }),
    verify: (input) =>
      Effect.sync(() => {
        verifies.push(input)
        return report
      })
  }
  return { forks, verifies, service }
}

const refusing: RunHistory.Service = {
  fork: () => Effect.fail(new RunHistory.HistoryRefused({ code: "history_frame_missing", message: "No frame 9" })),
  verify: () => Effect.fail(new RunHistory.HistoryRefused({ code: "history_missing", message: "No history" }))
}

const broken: RunHistory.Service = { fork: () => Effect.die("bug"), verify: () => Effect.die("bug") }
const unknown = "Something went wrong on our side. Not your fault."

describe("/verify-run", () => {
  test("prints the verdict and every list the report holds", async () => {
    const { service, verifies } = recording()
    expect(await History.verify(" run-1 ", service)).toBe(
      ["run-1 divergent", "replays 2", "resumes review", "executes c", "not replayed verify/second, d"].join("\n")
    )
    expect(verifies).toEqual([{ runId: "run-1" }])
  })

  test("omits what a consistent report does not hold", () => {
    expect(History.verifyLines({ runId: "run-2", verdict: "consistent", replayed: [], notReplayed: [] }))
      .toEqual(["run-2 consistent", "replays 0"])
  })

  test("refuses a missing or surplus run id without calling the host", async () => {
    const { service, verifies } = recording()
    for (const argument of ["", "   ", "run-1 run-2"]) {
      expect(await History.verify(argument, service)).toBe("Usage: /verify-run <run>")
    }
    expect(verifies).toEqual([])
  })

  test("prints the host's refusal, and the unknown-failure sentence for a defect", async () => {
    expect(await History.verify("run-1", refusing)).toBe("No history")
    expect(await History.verify("run-1", broken)).toBe(unknown)
  })
})

describe("/fork-run", () => {
  test("forks at the frame and prints the parked child", async () => {
    const { service, forks } = recording()
    expect(await History.fork("run-1 4", service)).toBe("run-1-fork parked (fork of run-1)")
    expect(forks).toEqual([{ runId: "run-1", at: 4 }])
  })

  test("carries one step's edited result, whose JSON may hold spaces", async () => {
    const { service, forks } = recording()
    await History.fork(`run-1 0 step=b result={"text": "hello world"}`, service)
    await History.fork(`run-1 2  step=c   result=7 `, service)
    expect(forks).toEqual([
      { runId: "run-1", at: 0, step: { stepKeyDigest: "b", result: { text: "hello world" } } },
      { runId: "run-1", at: 2, step: { stepKeyDigest: "c", result: 7 } }
    ])
  })

  test("refuses a malformed address or edit without calling the host", async () => {
    const { service, forks } = recording()
    const usage = "Usage: /fork-run <run> <at> [step=<digest> result=<json>]"
    const pair = "step= and result= edit a step together"
    for (
      const [argument, answer] of [
        ["", usage],
        ["run-1", usage],
        ["run-1 -1", usage],
        ["run-1 1.5", usage],
        ["run-1 99999999999999999999", usage],
        ["run-1 0 lineage=main", usage],
        ["run-1 0 step", usage],
        ["run-1 0 step=b", pair],
        ["run-1 0 result=1", pair],
        ["run-1 0 step= result=1", pair],
        ["run-1 0 step=b result=  ", pair],
        ["run-1 0 step=b result={", "result= must be JSON"]
      ] as const
    ) {
      expect(await History.fork(argument, service)).toBe(answer)
    }
    expect(forks).toEqual([])
  })

  test("prints the host's refusal, and the unknown-failure sentence for a defect", async () => {
    expect(await History.fork("run-1 9", refusing)).toBe("No frame 9")
    expect(await History.fork("run-1 9", broken)).toBe(unknown)
  })
})

describe("served", () => {
  /** A gateway double answering one exit line, recording the request. */
  const gateway = (exit: unknown, token?: string) => {
    const requests: Array<{ url: string; authorization: string | null; frame: unknown }> = []
    const history = History.served({
      url: "http://127.0.0.1:3000/",
      token,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        requests.push({ url, authorization: headers.get("authorization"), frame: JSON.parse(String(init?.body)) })
        return new Response(
          typeof exit === "string" ? exit : `${JSON.stringify({ _tag: "Exit", requestId: "1", exit })}\n`
        )
      }
    })
    return { history, requests }
  }

  test("posts the gateway frame to /projections and decodes the answer", async () => {
    const child = { runId: "run-1-fork", parentRunId: "run-1", status: "parked" }
    const forking = gateway({ _tag: "Success", value: child }, "secret")
    expect(await Effect.runPromise(forking.history.fork({ runId: "run-1", at: 3 }))).toEqual(child as never)
    expect(forking.requests).toEqual([{
      url: "http://127.0.0.1:3000/projections",
      authorization: "Bearer secret",
      frame: { _tag: "Request", id: 1, tag: "Run.Fork", payload: { runId: "run-1", at: 3 }, headers: [] }
    }])
    const verifying = gateway({ _tag: "Success", value: report })
    expect(await Effect.runPromise(verifying.history.verify({ runId: "run-1" }))).toEqual(report)
    expect(verifying.requests[0]?.authorization).toBeNull()
  })

  test("reads a typed refusal as its code and sentence", async () => {
    const refusals = [
      [{ _tag: "@smthrs/gateway/HistoryRefused", code: "history_missing", message: "No history" }, "history_missing"],
      [{ _tag: "/control/Unauthorized", message: "An operator credential is required" }, "/control/Unauthorized"]
    ] as const
    for (const [error, code] of refusals) {
      const { history } = gateway({ _tag: "Failure", cause: [{ _tag: "Interrupt" }, { _tag: "Fail", error }] })
      expect(await Effect.runPromise(Effect.flip(history.verify({ runId: "run-1" }))))
        .toMatchObject({ _tag: "@smthrs/gateway/HistoryRefused", code, message: error.message })
    }
  })

  test("treats a defect, a malformed answer and a transport failure as defects", async () => {
    const answers = [
      gateway({ _tag: "Failure", cause: [{ _tag: "Die", defect: "boom" }] }).history,
      gateway({ _tag: "Success", value: { runId: "run-1", verdict: "maybe" } }).history,
      gateway("not json").history,
      gateway("").history,
      History.served({ url: "http://127.0.0.1:1", fetch: async () => Promise.reject(new Error("refused")) })
    ]
    for (const history of answers) {
      const exit = await Effect.runPromiseExit(history.verify({ runId: "run-1" }))
      expect(Exit.isFailure(exit) && exit.cause.reasons.every((reason) => reason._tag === "Die")).toBe(true)
    }
  })
})
