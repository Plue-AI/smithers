/** A session health checker that asks Jev whether an agent is waiting on a person.
 *
 * Jev, TypeSafe's decision model, reads a state and answers typed questions
 * about it in about 300 ms. It writes no text, so it can never name an option
 * the question did not offer, and the questions in one request are answered in
 * parallel, so a second question costs no latency. The web app already asks it
 * through `apps/server/src/jev.ts`; the engine runs outside the Worker, so this
 * module is the same wire contract written with plain `fetch`.
 *
 * The state is the session's own lifecycle plus the newest bytes of its output.
 * The answer is a `ProbeReport` and nothing else: a checker's output never
 * authorizes a control mutation. There is no fallback. An unconfigured key and
 * an unreachable, refused, slow, or unreadable gateway fail the probe with a
 * {@link JevProbeError}, which `Health.evaluate` records as reason
 * `probe-error`; a stale `probe-error` never establishes activity and never
 * reads healthy. A host that binds `jev.session` is asserting Jev answers for
 * it, and a silent degrade would let that host page nobody while believing it
 * was watched.
 *
 * Two cases are not Jev failing. A session that is no longer alive and a
 * session whose output tail the host did not expose leave nothing to ask about,
 * so they keep the lifecycle answer. An answer below
 * {@link jevConfidenceFloor} is Jev's own decision that it does not know, and
 * stays `unknown`.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import type { CheckPolicy, HealthChecker, ProbeContext, ProbeReport } from "./Health.ts"

/** The probe could not ask Jev, or could not read what came back.
 *
 * `reason` is the fault class an operator acts on: `unconfigured` is a missing
 * `AI_GATEWAY_API_KEY` and the host's own to fix, `http` carries the gateway's
 * `status`, `timeout` is this call's deadline, `unreachable` is the transport,
 * and `malformed` is a body that is not the answer to the question asked.
 *
 * @category errors
 * @since 1.0.0
 */
export class JevProbeError extends Schema.TaggedError<JevProbeError>()("JevProbeError", {
  reason: Schema.Literals(["unconfigured", "http", "timeout", "unreachable", "malformed"]),
  status: Schema.optional(Schema.Number)
}) {}

/** The Vercel AI Gateway route that serves evaluation models.
 * @category constants
 * @since 1.0.0
 */
export const jevEvaluationUrl = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"

/** The gateway's id for Jev.
 * @category constants
 * @since 1.0.0
 */
export const jevModelId = "typesafe-ai/jev"

/** The newest characters of session output carried as state.
 *
 * A waiting prompt is the last thing an agent printed, so the clip keeps the
 * end. Four KiB holds a screenful of tool output ahead of the prompt without
 * paying for a scrollback the question cannot use.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevStateTailCharacters = 4 * 1024

/** The deadline on one gateway call.
 *
 * Jev answers in about 300 ms; a status that arrives after the operator has
 * looked away is noise, and a slow gateway must not hold a probe slot.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevRequestTimeoutMs = 1_500

/** The probe budget this checker asks a binding for.
 *
 * It sits above {@link jevRequestTimeoutMs} so this checker's own abort, which
 * fails with a `timeout` reason of its own, fires before `Health.evaluate`
 * records a bare `probe-timeout` that says nothing about which call was slow.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevProbeTimeoutMs = 2_500

/** The confidence an answer must carry before it becomes a status.
 *
 * TypeSafe reports 76% agreement with frontier-model reference labels on its
 * own evals, so a Jev that is merely leaning is a coin flip dressed as a
 * reading. Below this floor the probe answers `unknown`: a false `needs-input`
 * pages a person who is not needed, and a false `idle` retires an agent that
 * is still working.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevConfidenceFloor = 0.7

/** Injection points for the one network call this checker makes.
 *
 * `env` and `fetch` default to the host process; naming either one keeps a test
 * or a hermetic host off the network and off the ambient key.
 *
 * @category models
 * @since 1.0.0
 */
export interface JevSessionCheckerOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly url?: string | undefined
  readonly timeoutMs?: number | undefined
}

/** What the lifecycle session checker answers, for the two states with nothing to ask about. */
const lifecycleReport: ProbeReport = { activity: "unknown", reason: "ok" }

/** The options Jev chooses between, and what each one means to a reader of terminal output. */
const activityCriteria = {
  "working": "the agent is executing tools, editing files, or producing work",
  "idle": "the agent finished and is producing nothing",
  "needs-input": "the agent asked the person a question, requested approval or a credential, and is waiting"
} as const

const questions = {
  activity: {
    type: "choice",
    instructions: "Read the tail of this agent session's output. What is the agent doing right now?",
    criteria: activityCriteria
  },
  question: {
    type: "boolean",
    instructions: "Does the output end with the agent waiting for a person to answer?"
  }
} as const

/** Reads the host process environment by deliberate default, spelled once rather than inline. */
const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

const confidenceOf = (payload: unknown, id: string): number => {
  const metadata = (payload as { providerMetadata?: { typesafe?: { confidence?: Record<string, unknown> } } })
    ?.providerMetadata?.typesafe?.confidence?.[id]
  return typeof metadata === "number" ? metadata : 0
}

/** Whether the gateway answered the question this checker asked. */
const offered = (choice: string): choice is keyof typeof activityCriteria => Object.hasOwn(activityCriteria, choice)

/** One evaluation's decoded body, or the typed failure that says why there is none. */
const evaluate = async (
  options: JevSessionCheckerOptions,
  key: string,
  state: { readonly alive: boolean; readonly exitCode: number | null; readonly outputTail: string }
): Promise<unknown> => {
  const signal = AbortSignal.timeout(options.timeoutMs ?? jevRequestTimeoutMs)
  let response: Response
  try {
    response = await (options.fetch ?? globalThis.fetch)(options.url ?? jevEvaluationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "ai-gateway-protocol-version": "0.0.1",
        "ai-gateway-auth-method": "api-key",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": jevModelId,
        "content-type": "application/json"
      },
      // Session output is the operator's terminal. It is read for one decision and never retained.
      body: JSON.stringify({ state, questions, providerOptions: { gateway: { zeroDataRetention: true } } }),
      signal
    })
  } catch {
    // A dead socket, a refused connection, a bad name and this call's own
    // deadline all land here; only the signal knows which one it was.
    return new JevProbeError({ reason: signal.aborted ? "timeout" : "unreachable" })
  }
  if (!response.ok) {
    await response.body?.cancel()
    // A bad key, a plan refusal and a rate limit differ to the operator who has
    // to fix them, so the status travels with the failure.
    return new JevProbeError({ reason: "http", status: response.status })
  }
  try {
    return await response.json()
  } catch {
    return new JevProbeError({ reason: "malformed" })
  }
}

/** Build a Jev session checker over an explicit environment and transport.
 *
 * Without an exposed output tail, or against a session that is no longer
 * alive, the probe answers exactly what `Health.lifecycleSessionChecker`
 * answers and never opens a connection. Everything else that stops Jev from
 * answering fails the probe with a {@link JevProbeError}, starting with a
 * missing `AI_GATEWAY_API_KEY`: binding this checker is a promise that the key
 * is there, and a host that breaks the promise must read `probe-error` rather
 * than a clean unknown.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeJevSessionChecker = (options: JevSessionCheckerOptions = {}): HealthChecker => ({
  id: "jev.session",
  defaults: { timeoutMs: jevProbeTimeoutMs } satisfies Partial<CheckPolicy>,
  probe: (context: ProbeContext) =>
    Effect.gen(function*() {
      const session = context.session
      const tail = session?.outputTail
      if (session === undefined || !session.alive || tail === undefined || tail === "") return lifecycleReport
      const key = (options.env ?? ambientEnvironment())["AI_GATEWAY_API_KEY"]
      if (key === undefined || key === "") return yield* Effect.fail(new JevProbeError({ reason: "unconfigured" }))
      const payload = yield* Effect.promise(() =>
        evaluate(options, key, {
          alive: session.alive,
          exitCode: session.exitCode,
          outputTail: tail.length > jevStateTailCharacters ? tail.slice(-jevStateTailCharacters) : tail
        })
      )
      if (payload instanceof JevProbeError) return yield* Effect.fail(payload)
      const answer = (payload as { answers?: Record<string, { type?: string; choice?: unknown }> })?.answers?.[
        "activity"
      ]
      const choice = answer?.type === "choice" && typeof answer.choice === "string" ? answer.choice : undefined
      // A missing answer, a wrong-typed one, and an option the questions never
      // offered are the gateway breaking the contract, not Jev deciding.
      if (choice === undefined || !offered(choice)) {
        return yield* Effect.fail(new JevProbeError({ reason: "malformed" }))
      }
      // The boolean rides along for free and is recorded as evidence only. It
      // has to be scored against the choice before it earns a vote in it. A
      // boolean answer carries its probability directly and no confidence.
      const waiting = (payload as { answers?: Record<string, { probability?: unknown }> })?.answers?.["question"]
        ?.probability
      yield* Effect.annotateCurrentSpan({ "jev.waiting": typeof waiting === "number" ? waiting : -1 })
      // Below the floor Jev has answered, and the answer is that it does not
      // know. That is the decision, not a fallback around a broken gateway.
      if (confidenceOf(payload, "activity") < jevConfidenceFloor) return lifecycleReport
      return choice === "needs-input"
        ? { activity: "needs-input", reason: "prompt-detected" }
        : { activity: choice, reason: "ok" }
    })
})

/** The checker `makeRegistry` admits under `jev.session`, reading the host's own environment.
 *
 * It is registered, not bound: a host opts in by naming `jev.session` as a
 * `HealthBinding.checkerId` with `exposeOutput: true`, and every host that does
 * not keeps the lifecycle default it had.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevSessionChecker: HealthChecker = makeJevSessionChecker()
