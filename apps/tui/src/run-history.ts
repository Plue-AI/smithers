/**
 * `/verify-run <run>` and `/fork-run <run> <at> [step=<digest> result=<json>]`:
 * a run's recorded history through the gateway's `Run.Verify` and `Run.Fork`
 * (`@smthrs/gateway/RunHistory`), so the terminal reads the report the app and
 * `smthrs runs verify` read and forks the way `smthrs runs fork` does.
 * `served` calls a `smthrs serve` gateway over the same frame the product
 * relay writes, which a Bun process can do (the history library opens its
 * stores with the Node adapter). Each note is the transcript text; the caller
 * appends it.
 */
import * as RunHistory from "@smthrs/gateway/RunHistory"
import { Cause, Effect, Exit, Option, Schema } from "effect"

const unknown = "Something went wrong on our side. Not your fault."

/** Where a served gateway answers, and the credential it takes. */
export interface Gateway {
  /** The gateway's base URL, as `smthrs serve` prints it. */
  readonly url: string
  /** `SMITHERS_TOKEN` or a scoped token holding `write:runs`. */
  readonly token?: string | undefined
  readonly fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined
}

const decodeExit = Schema.decodeUnknownOption(Schema.Struct({
  exit: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Unknown }),
    Schema.Struct({ _tag: Schema.Literal("Failure"), cause: Schema.Array(Schema.Unknown) })
  ])
}))
const decodeRefusal = Schema.decodeUnknownOption(Schema.Struct({
  _tag: Schema.Literal("Fail"),
  error: Schema.Struct({ _tag: Schema.String, message: Schema.String, code: Schema.optional(Schema.String) })
}))

/**
 * One gateway procedure: its success decoded as `success`; a typed refusal
 * (the host's `HistoryRefused`, or the gateway's `Unauthorized` and
 * `Unavailable`) as a `HistoryRefused` carrying its code and sentence; anything
 * else a defect.
 */
const call = <A, E>(
  gateway: Gateway,
  tag: string,
  payload: unknown,
  success: (value: unknown) => Effect.Effect<A, E>
) =>
  Effect.gen(function*() {
    const response = yield* Effect.tryPromise(() =>
      (gateway.fetch ?? fetch)(`${gateway.url.replace(/\/+$/, "")}/projections`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(gateway.token === undefined ? {} : { authorization: `Bearer ${gateway.token}` })
        },
        body: `${JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] })}\n`
      }).then((answer) => answer.text())
    ).pipe(Effect.orDie)
    const exit = decodeExit((() => {
      try {
        return JSON.parse(response.trim().split("\n")[0] ?? "")
      } catch {
        return undefined
      }
    })())
    if (Option.isNone(exit)) return yield* Effect.die(new Error(`${tag} answered in an unknown shape`))
    if (exit.value.exit._tag === "Success") {
      return yield* success(exit.value.exit.value).pipe(Effect.orDie)
    }
    const refused = Option.firstSomeOf(exit.value.exit.cause.map((reason) => decodeRefusal(reason)))
    if (Option.isNone(refused)) return yield* Effect.die(new Error(`${tag} failed`))
    const error = refused.value.error
    return yield* new RunHistory.HistoryRefused({ code: error.code ?? error._tag, message: error.message })
  })

/** The history service a served gateway answers. */
export const served = (gateway: Gateway): RunHistory.Service => ({
  fork: (input) => call(gateway, "Run.Fork", input, Schema.decodeUnknownEffect(RunHistory.ForkOutput)),
  verify: (input) => call(gateway, "Run.Verify", input, Schema.decodeUnknownEffect(RunHistory.VerifyReport))
})

const label = (step: RunHistory.Step): string => step.action ?? step.node ?? step.stepKeyDigest

/** The report as transcript lines: the verdict, then each list the report holds. */
export const verifyLines = (report: RunHistory.VerifyReport): ReadonlyArray<string> => [
  `${report.runId} ${report.verdict}`,
  `replays ${report.replayed.length}`,
  ...(report.resumes === undefined ? [] : [`resumes ${label(report.resumes)}`]),
  ...(report.executes === undefined ? [] : [`executes ${label(report.executes)}`]),
  ...(report.notReplayed.length === 0 ? [] : [`not replayed ${report.notReplayed.map(label).join(", ")}`])
]

/** The fork as a transcript line: the parked child and where it came from. */
export const forkLine = (fork: RunHistory.ForkOutput): string =>
  `${fork.runId} ${fork.status} (fork of ${fork.parentRunId})`

/** The refusal's sentence; a defect reads as the one sentence nobody designed. */
const refusal = (cause: Cause.Cause<RunHistory.HistoryRefused>): string =>
  Option.match(Cause.findErrorOption(cause), { onNone: () => unknown, onSome: (refused) => refused.message })

/** The note for `/verify-run <run>`. */
export const verify = async (argument: string, history: RunHistory.Service): Promise<string> => {
  const words = argument.trim().split(/\s+/).filter((word) => word !== "")
  if (words.length !== 1) return "Usage: /verify-run <run>"
  const exit = await Effect.runPromiseExit(history.verify({ runId: words[0]! }))
  return Exit.isSuccess(exit) ? verifyLines(exit.value).join("\n") : refusal(exit.cause)
}

const forkUsage = "Usage: /fork-run <run> <at> [step=<digest> result=<json>]"

/**
 * Reads `step=<digest> result=<json>` into the edit a fork carries; both or
 * neither. `result=` comes last and takes the rest of the line, so its JSON
 * may hold spaces.
 */
const edit = (rest: string): RunHistory.StepEdit | undefined | string => {
  if (rest === "") return undefined
  const matched = /^step=(\S*)(?:\s+result=([\s\S]*))?$/.exec(rest)
  if (matched === null) return /^(?:step|result)=/.test(rest) ? "step= and result= edit a step together" : forkUsage
  const [, step, result] = matched
  if (step === "" || result === undefined || result.trim() === "") return "step= and result= edit a step together"
  try {
    return { stepKeyDigest: step!, result: JSON.parse(result) as RunHistory.StepEdit["result"] }
  } catch {
    return "result= must be JSON"
  }
}

/** The note for `/fork-run <run> <at> [step=<digest> result=<json>]`. */
export const fork = async (argument: string, history: RunHistory.Service): Promise<string> => {
  const matched = /^(\S+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(argument.trim())
  const frame = matched === null ? undefined : Number(matched[2])
  if (matched === null || frame === undefined || !Number.isSafeInteger(frame)) return forkUsage
  const step = edit((matched[3] ?? "").trim())
  if (typeof step === "string") return step
  const exit = await Effect.runPromiseExit(
    history.fork({ runId: matched[1]!, at: frame, ...(step === undefined ? {} : { step }) })
  )
  return Exit.isSuccess(exit) ? forkLine(exit.value) : refusal(exit.cause)
}
