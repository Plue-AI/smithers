/**
 * Runs a character suite: how an agent profile speaks and acts, scored.
 *
 * ```bash
 * bun evals/agent/character/run.ts --suite <dir>                 # offline: goldens pass, counterexamples fail
 * bun evals/agent/character/run.ts --suite <dir> --live --trials 3 --judge
 * bun evals/agent/character/run.ts --suite <dir> --live --profile old.md --label before
 * bun evals/agent/character/run.ts --suite <dir> --calibrate     # judge agreement on labelled examples
 * ```
 *
 * Offline (the default) replays every golden transcript and every
 * counterexample through the real agent loop and the world's tools with a
 * scripted model, and exits 0 only when every golden passes and every
 * counterexample fails. It spends nothing and is deterministic: it is the gate
 * that keeps the cases and the scorers honest.
 *
 * `--live` runs the suite's profile on a subscription seat (`--seat`, default
 * the suite's) for `--trials` runs per case, at most `--concurrency` (default
 * 2) cases at once, and reports pass@1, pass@k and pass^k (every run passed)
 * through `@smthrs/evals` `Trials`. `--judge` adds the rubric judge on turns
 * that passed every deterministic check. Usage is summed from the provider's
 * token counts and converted to a share of the weekly subscription limit with
 * the suite's `usageWeights`. Results go to `<suite>/results/`, and a line is
 * appended to `<suite>/REGRESSION-LOG.md`.
 *
 * `--rescore <results.json>` scores an earlier live run's conversations again
 * with the current cases and checks, without calling the role's model; with
 * `--judge`, a turn is judged again when it has no verdict or its verdict was
 * made under other judge notes or another rubric (`Rubric.judgeKey`), and
 * `--rejudge` judges every conversation again. `--check-profile` composes the
 * suite's profile (shared instructions, charter, skills, byte caps), prints
 * what it found and exits; it is the check for a profile.
 *
 * Other flags: `--coverage` lists how many cases test each spec rule; `--cases a,b` keeps some cases; `--category a,b` keeps some
 * categories; `--reply-from summary` reads a RoleResult reply's summary; `--profile <file>` and `--common <file>` swap the
 * profile or the shared instructions; `--label <name>` names the run; `--trace` prints every turn.
 *
 * Exit codes: 0 pass, 1 fail, 5 the harness could not run.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { CaseExecutor, EvalError, Runner, Suite, Trials } from "../../../packages/smithers/agent/evals/src/index.ts"
import {
  Binding,
  Checks,
  Rubric,
  Runner as ScorerRunner,
  Scorer
} from "../../../packages/smithers/agent/scorers/src/index.ts"
import type { Seat } from "../../../packages/smithers/agent/src/index.ts"
import * as Event from "./event.ts"
import * as Profile from "./profile.ts"
import * as CharacterRubric from "./rubric.ts"
import * as Score from "./score.ts"
import * as Subject from "./subject.ts"
import * as CharacterSuite from "./suite.ts"
import * as World from "./world.ts"

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? undefined : argv[index + 1]
}

const suiteDir = resolve(option("suite") ?? new URL("./example", import.meta.url).pathname)
const live = flag("live")
const calibrate = flag("calibrate")
const judging = flag("judge") || calibrate
let trials = Number(option("trials") ?? 1)
// `--rescore <results.json>` scores the conversations of an earlier live run
// again with the current cases and checks, without calling the role's model;
// with `--judge`, a conversation goes to the judge when it has no verdict or
// its verdict's notes or rubric changed (`--rejudge`: every conversation).
const rescoreFile = option("rescore")
const rejudge = flag("rejudge")
const reportLive = live || rescoreFile !== undefined
const concurrency = Number(option("concurrency") ?? 2)
const trace = flag("trace")
const only = option("cases")?.split(",").map((name) => name.trim()).filter((name) => name.length > 0)
const profileFile = option("profile")
const label = CharacterSuite.runLabel(option("label") ?? (live ? "live" : "offline"))
// `--reply-from summary`: a profile written for the old organization host
// answers with a RoleResult JSON object, and that host posted its `summary`.
// Taking the summary (untruncated) scores the old profile's words, not its
// wire format, which is the generous reading of it.
const replyFrom = option("reply-from")

const categories = option("category")?.split(",").map((name) => name.trim())
const loaded = CharacterSuite.load(suiteDir, only)
const suite: CharacterSuite.Suite = categories === undefined
  ? loaded
  : { ...loaded, cases: loaded.cases.filter((suiteCase) => categories.includes(suiteCase.category)) }
const commonFile = option("common")
// A profile that does not compose (a listed skill missing, a part over its
// byte cap) stops every mode here, named, before anything runs or spends.
const composed = ((): Profile.Composed => {
  try {
    return Profile.compose({
      org: suite.org,
      role: suite.role,
      profile: profileFile === undefined ? suite.profile : resolve(profileFile),
      commonFile: commonFile === undefined ? undefined : resolve(commonFile)
    })
  } catch (error) {
    process.stderr.write(`not ok: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(5)
  }
})()
const seatId = option("seat") ?? suite.seat
let liveSeat: Seat.Seat | undefined

if (flag("check-profile")) {
  const cap = (used: number, limit: number) => `${used} of ${limit} bytes`
  process.stdout.write(
    [
      `ok ${composed.name} (${composed.role})`,
      `seat: ${composed.seat || "(suite's)"}; effort: ${composed.effort ?? "(default)"}`,
      `skills: ${composed.skills.length === 0 ? "(none)" : composed.skills.join(", ")}`,
      `common instructions: ${cap(composed.bytes.common, Profile.limits.common)}`,
      `charter: ${cap(composed.bytes.charter, Profile.limits.charter)}`,
      `skills: ${composed.bytes.skills} bytes (${Profile.limits.skill} per skill)`,
      `digest: ${composed.digest}`
    ].join("\n") + "\n"
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// One conversation

/** What one variant of a case is: the live profile, a golden replay, or one counterexample. */
type Variant =
  | { readonly kind: "live" }
  | { readonly kind: "golden" }
  | { readonly kind: "counterexample"; readonly turn: number; readonly index: number }

interface TurnResult {
  readonly prompt: string
  readonly trigger: CharacterSuite.Message
  readonly turn: Subject.Turn
  readonly checks: ReadonlyArray<Checks.Check>
}

interface Conversation {
  readonly caseId: string
  readonly variant: string
  readonly trial: number
  readonly turns: ReadonlyArray<TurnResult>
}

// A counterexample replaces one turn; every other turn replays its golden, so
// each counterexample is caught (or not) on its own.
const transcriptFor = (turn: CharacterSuite.Turn, index: number, variant: Variant): Subject.Transcript | undefined => {
  if (variant.kind === "golden") return turn.golden
  if (variant.kind === "counterexample") {
    return variant.turn === index
      ? turn.counterexamples?.[variant.index]
      : turn.golden
  }
  return undefined
}

const describeActions = (actions: ReadonlyArray<World.Action>): string =>
  actions.filter((action) =>
    ![
      "requests_list",
      "wiki_search",
      "email_search",
      "issues_search",
      "chat_search",
      "notes_read",
      "calendar_list",
      "calendar_freebusy",
      "repo_read",
      "repo_search"
    ].includes(action.tool)
  )
    .map((action) => {
      const out = action.output === undefined ? "" : ` → ${JSON.stringify(action.output).slice(0, 160)}`
      return `${action.tool} ${JSON.stringify(action.input).slice(0, 240)}${out}`
    }).join("; ")

const summaryOf = (reply: string | undefined): string | undefined => {
  if (reply === undefined) return undefined
  try {
    const parsed = JSON.parse(reply) as { readonly summary?: unknown }
    return typeof parsed.summary === "string" ? parsed.summary : reply
  } catch {
    return reply
  }
}

const converse = (suiteCase: CharacterSuite.Case, variant: Variant, trial: number): Effect.Effect<Conversation> =>
  Effect.gen(function*() {
    const results: Array<TurnResult> = []
    const history: Array<CharacterSuite.Message> = [...suiteCase.history]
    for (const [index, turn] of suiteCase.turns.entries()) {
      const world = World.load(suite.world, suiteCase.world)
      const prompt = Event.render({ world, role: suite.role, where: suiteCase.where, history, trigger: turn.trigger })
      const transcript = transcriptFor(turn, index, variant)
      if (variant.kind !== "live" && transcript === undefined) {
        results.push({
          prompt,
          trigger: turn.trigger,
          turn: {
            reply: undefined,
            actions: [],
            failure: "no transcript for this turn",
            modelCalls: 0,
            usage: [],
            durationMs: 0
          },
          checks: []
        })
        break
      }
      // Every trial of a turn uses the same session id: the harness keys the
      // provider's prompt cache on session and system prompt, so later trials
      // reuse the first one's cached prefix. Runs stay independent (each turn
      // gets a fresh engine and world); only the provider's cache is shared.
      const run = (seat: Seat.Seat) =>
        Subject.runTurn({ composed, seat, world, prompt, idBase: index * 100, session: `${suiteCase.id}-${index}` })
      // A transport failure is the network's, not the profile's: it is retried
      // twice on the same executor, which replaces failed pools itself.
      const liveTurn = Effect.suspend(() =>
        liveSeat === undefined ? Effect.die("Live seat was not resolved") : run(liveSeat)
      )
      let raw = variant.kind === "live" ? yield* liveTurn : yield* run(Subject.replaySeat(transcript!))
      for (
        let attempt = 1;
        variant.kind === "live" && attempt <= 2 && (raw.failure ?? "").includes("transport");
        attempt++
      ) {
        process.stderr.write(`   (transport failure on ${suiteCase.id}, retry ${attempt})\n`)
        raw = yield* liveTurn
      }
      const outcome = replyFrom === "summary" ? { ...raw, reply: summaryOf(raw.reply) } : raw
      const checks = Score.score({ suite, world, trigger: turn.trigger, expect: turn.expect, turn: outcome })
      results.push({ prompt, trigger: turn.trigger, turn: outcome, checks })
      if (trace) {
        process.stderr.write(
          `\n── ${suiteCase.id} [${variantName(variant)} #${trial}] turn ${index + 1}\n${turn.trigger.text}\n→ ${
            outcome.reply ?? `FAILED ${outcome.failure}`
          }\n   actions: ${describeActions(outcome.actions)}\n`
        )
        for (const check of checks.filter((c) => !c.pass)) process.stderr.write(`   ✗ ${check.id}: ${check.detail}\n`)
      }
      history.push({ from: turn.trigger.from, text: turn.trigger.text, at: turn.trigger.at })
      const did = describeActions(outcome.actions)
      history.push({ from: suite.role, text: `${outcome.reply ?? ""}${did === "" ? "" : `\n(what you did: ${did})`}` })
    }
    return { caseId: suiteCase.id, variant: variantName(variant), trial, turns: results }
  })

const variantName = (variant: Variant): string =>
  variant.kind === "counterexample" ? `turn-${variant.turn + 1}-counterexample-${variant.index + 1}` : variant.kind

// ---------------------------------------------------------------------------
// Scoring through @smthrs/evals

const target = {
  capabilities: [],
  name: "evals/agent/character/turns",
  description: "One conversation of an agent profile."
}

const byId = new Map(suite.cases.map((suiteCase) => [suiteCase.id, suiteCase]))

const checksScorer = Checks.scorer({
  id: "evals/agent/character/checks",
  version: "1",
  checks: ({ output }) =>
    (output as Conversation).turns.flatMap((turn, index) =>
      turn.checks.length === 0 && turn.turn.reply === undefined
        ? [{ id: `turn ${index + 1}: run`, pass: false, detail: turn.turn.failure ?? "did not run" }]
        : turn.checks.map((check) => ({ ...check, id: `turn ${index + 1}: ${check.id}` }))
    )
})

const calibration = suite.calibration === undefined ? [] : CharacterRubric.loadCalibration(suite.calibration)

let judgeScorer: Scorer.Scorer | undefined

const judgeContext = (result: TurnResult): string =>
  [
    "What the team member was given:",
    result.prompt,
    "",
    "What it did (tool calls, in order):",
    CharacterRubric.actionsSummary(result.turn.actions)
  ].join("\n")

const judgeTurn = (suiteCase: CharacterSuite.Case, index: number, result: TurnResult) =>
  judgeScorer!.score({
    input: { context: judgeContext(result), focus: suiteCase.turns[index]!.expect.focus },
    output: CharacterRubric.judgedOutput(result.trigger, result.turn)
  })

const characterJudge = Scorer.make({
  id: "evals/agent/character/judge",
  version: "1",
  score: ({ output }) =>
    Effect.gen(function*() {
      const conversation = output as Conversation
      const suiteCase = byId.get(conversation.caseId)!
      const verdicts: Array<
        { readonly turn: number; readonly pass: boolean; readonly scores: unknown; readonly reason: string }
      > = []
      for (const [index, result] of conversation.turns.entries()) {
        const expect = suiteCase.turns[index]!.expect
        if (
          expect.judge === false || !result.checks.every((check) => check.pass) || result.turn.reply === undefined
        ) continue
        const graded = yield* judgeTurn(suiteCase, index, result)
        const meta = graded.meta as { readonly pass: boolean; readonly scores: unknown }
        verdicts.push({ turn: index + 1, pass: meta.pass, scores: meta.scores, reason: graded.reason ?? "" })
      }
      const pass = verdicts.every((verdict) => verdict.pass)
      return {
        score: verdicts.length === 0 ? 1 : verdicts.filter((verdict) => verdict.pass).length / verdicts.length,
        reason: verdicts.length === 0
          ? "not judged"
          : verdicts.map((verdict) => `turn ${verdict.turn}: ${verdict.pass ? "pass" : "fail"} — ${verdict.reason}`)
            .join(" | "),
        meta: { pass, judged: verdicts.length, verdicts }
      }
    })
})

const scoring: Runner.ScoreBatchRunner = {
  runBatch: (jobs, options) =>
    Effect.forEach(
      jobs,
      (job) =>
        job.score.pipe(
          Effect.flatMap(Scorer.validate),
          Effect.map((result) => ({
            ...job.observation,
            kind: "score" as const,
            score: result.score,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            ...(result.meta === undefined ? {} : { meta: result.meta }),
            at: job.at ?? 0
          })),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(ScorerRunner.inconclusive(job, cause))
          )
        ),
      { concurrency: options?.concurrency ?? 1 }
    )
}

const variantsOf = (suiteCase: CharacterSuite.Case): Array<Variant> => {
  if (live) return [{ kind: "live" }]
  return [
    { kind: "golden" },
    ...suiteCase.turns.flatMap((turn, index) =>
      (turn.counterexamples ?? []).map((_, which) => ({ kind: "counterexample" as const, turn: index, index: which }))
    )
  ]
}

interface Planned {
  readonly suiteCase: CharacterSuite.Case
  readonly variant: Variant
  readonly trial: number
}

const planned: Array<Planned> = suite.cases.flatMap((suiteCase) =>
  variantsOf(suiteCase).flatMap((variant) =>
    Array.from(
      { length: variant.kind === "live" ? trials : 1 },
      (_, trial) => ({ suiteCase, variant, trial: trial + 1 })
    )
  )
)

const executor = CaseExecutor.make((suiteCase) => {
  const plan = planned[(suiteCase.input as { readonly index: number }).index]!
  const started = performance.now()
  return converse(plan.suiteCase, plan.variant, plan.trial).pipe(
    Effect.map((output) => ({
      output,
      stepKey: `evals/agent/character:${suiteCase.name}`,
      latencyMs: performance.now() - started,
      target
    })),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.fail(
          new EvalError.EvalError({ code: "executor", message: `Case '${suiteCase.name}' did not finish`, cause })
        )
    )
  )
})

// ---------------------------------------------------------------------------
// Usage

interface Weights {
  readonly fresh: number
  readonly cached: number
  readonly output: number
}

const weightsFor = (seat: string): Weights | undefined => suite.usageWeights[seat]

const sum = (usage: ReadonlyArray<Subject.Usage>) =>
  usage.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      cached: acc.cached + u.cached,
      output: acc.output + u.output,
      reasoning: acc.reasoning + u.reasoning
    }),
    { input: 0, cached: 0, output: 0, reasoning: 0 }
  )

const percent = (usage: ReturnType<typeof sum>, weights: Weights | undefined): number | undefined =>
  weights === undefined
    ? undefined
    : usage.input / weights.fresh + usage.cached / weights.cached + usage.output / weights.output

// ---------------------------------------------------------------------------
// Calibration

const runCalibration = Effect.gen(function*() {
  const pairs: Array<{ readonly expected: "pass" | "fail"; readonly actual: "pass" | "fail" }> = []
  const lines: Array<string> = []
  for (const example of calibration) {
    const graded = yield* judgeScorer!.score({
      input: { context: example.context, focus: example.focus },
      output: example.output
    })
    const meta = graded.meta as { readonly pass: boolean; readonly scores: Record<string, number> }
    const actual = meta.pass ? "pass" : "fail"
    pairs.push({ expected: example.verdict, actual })
    lines.push(
      `${actual === example.verdict ? "✓" : "✗"} ${example.id}: labelled ${example.verdict}, judged ${actual} ${
        JSON.stringify(meta.scores)
      } — ${graded.reason ?? ""}`
    )
  }
  const agreement = Rubric.agreement(pairs)
  return { agreement, lines }
})

// ---------------------------------------------------------------------------
// Main

const stamp = new Date().toISOString().replace(/[:.]/g, "-")

interface Outcome {
  readonly plan: Planned
  readonly conversation: Conversation | undefined
  readonly error: string | undefined
  readonly checksPass: boolean
  readonly judgePass: boolean
  readonly pass: boolean
  readonly failed: ReadonlyArray<Checks.Check>
  readonly judgeReason: string | undefined
}

interface SavedConversation {
  readonly case: string
  readonly trial: number
  readonly checksPass: boolean
  readonly judgePass: boolean
  readonly judge?: string | undefined
  /** What the verdict depended on (`Rubric.judgeKey`); absent in runs saved before it existed. */
  readonly judgeKey?: string | undefined
  readonly turns?: ReadonlyArray<{
    readonly trigger: CharacterSuite.Message
    readonly reply: string | undefined
    readonly failure: string | undefined
    readonly actions: ReadonlyArray<World.Action>
    readonly modelCalls: number
    readonly usage: Subject.Usage
    readonly durationMs: number
  }>
}

const rescore = (file: string) =>
  Effect.gen(function*() {
    const saved = JSON.parse(readFileSync(resolve(file), "utf8")) as {
      readonly summary: { readonly trials: number }
      readonly conversations: ReadonlyArray<SavedConversation>
    }
    trials = saved.summary.trials
    const outcomes: Array<Outcome> = []
    for (const conversation of saved.conversations) {
      const suiteCase = byId.get(conversation.case)
      if (suiteCase === undefined) continue
      const history: Array<CharacterSuite.Message> = [...suiteCase.history]
      const results: Array<TurnResult> = []
      for (const [index, savedTurn] of (conversation.turns ?? []).entries()) {
        const expect = suiteCase.turns[index]?.expect ?? {}
        const world = World.load(suite.world, suiteCase.world)
        const prompt = Event.render({
          world,
          role: suite.role,
          where: suiteCase.where,
          history,
          trigger: savedTurn.trigger
        })
        const turn: Subject.Turn = {
          reply: savedTurn.reply ?? undefined,
          actions: savedTurn.actions,
          failure: savedTurn.failure ?? undefined,
          modelCalls: savedTurn.modelCalls,
          usage: [savedTurn.usage],
          durationMs: savedTurn.durationMs
        }
        results.push({
          prompt,
          trigger: savedTurn.trigger,
          turn,
          checks: Score.score({ suite, world, trigger: savedTurn.trigger, expect, turn })
        })
        history.push({ from: savedTurn.trigger.from, text: savedTurn.trigger.text, at: savedTurn.trigger.at })
        const did = describeActions(turn.actions)
        history.push({ from: suite.role, text: `${turn.reply ?? ""}${did === "" ? "" : `\n(what you did: ${did})`}` })
      }
      const failed = results.flatMap((result, index) =>
        result.turn.reply === undefined && result.checks.length === 0
          ? [{ id: `turn ${index + 1}: run`, pass: false, detail: result.turn.failure ?? "did not run" }]
          : result.checks.filter((check) => !check.pass).map((check) => ({
            ...check,
            id: `turn ${index + 1}: ${check.id}`
          }))
      )
      const checksPass = results.length > 0 && failed.length === 0
      let judgePass = conversation.judgePass
      let judgeReason = conversation.judge
      if (
        checksPass && judgeScorer !== undefined &&
        (rejudge || CharacterRubric.needsJudge(conversation, CharacterRubric.judgeKey(suiteCase)))
      ) {
        const graded = yield* characterJudge.score({
          input: {},
          output: {
            caseId: suiteCase.id,
            variant: "live",
            trial: conversation.trial,
            turns: results
          } satisfies Conversation
        })
        judgePass = (graded.meta as { readonly pass: boolean }).pass
        judgeReason = graded.reason
      }
      outcomes.push({
        plan: { suiteCase, variant: { kind: "live" }, trial: conversation.trial },
        conversation: { caseId: suiteCase.id, variant: "live", trial: conversation.trial, turns: results },
        error: undefined,
        checksPass,
        judgePass: checksPass ? judgePass : true,
        pass: checksPass && judgePass,
        failed,
        judgeReason: checksPass ? judgeReason : undefined
      })
    }
    return outcomes
  })

const program = Effect.gen(function*() {
  if (live || judging) {
    const root = process.cwd()
    if (live) liveSeat = yield* Subject.resolveLive(seatId, root)
    if (judging) {
      judgeScorer = CharacterRubric.make(
        CharacterRubric.seatJudge(suite.judgeSeat, root),
        CharacterRubric.anchors(calibration)
      ) as unknown as Scorer.Scorer
    }
  }
  if (calibrate) {
    const { agreement, lines } = yield* runCalibration
    process.stdout.write(
      `${lines.join("\n")}\n\njudge agreement: ${agreement.agree}/${agreement.total} (${
        (agreement.accuracy * 100).toFixed(0)
      }%), false pass ${agreement.falsePass}, false fail ${agreement.falseFail}\n`
    )
    const judgeUse = sum(CharacterRubric.judgeUsage)
    process.stdout.write(
      `judge usage: ${JSON.stringify(judgeUse)}; ${
        (percent(judgeUse, weightsFor(suite.judgeSeat)) ?? 0).toFixed(3)
      }% of the week\n`
    )
    return agreement.falsePass === 0 && agreement.accuracy >= 0.8 ? 0 : 1
  }
  const outcomes: ReadonlyArray<Outcome> = rescoreFile !== undefined
    ? yield* rescore(rescoreFile)
    : yield* Effect.gen(function*() {
      const bindings = [
        Binding.make({ scorer: checksScorer, appliesTo: target }),
        ...(judging ? [Binding.make({ scorer: characterJudge, appliesTo: target })] : [])
      ]
      const evalSuite = yield* Suite.make({
        name: `character:${suite.name}`,
        cases: planned.map((plan, index) => ({
          name: `${plan.suiteCase.id}/${variantName(plan.variant)}/${plan.trial}`,
          input: { index }
        })),
        bindings,
        concurrency: live ? concurrency : 1
      })
      const run = yield* Runner.run(evalSuite, {
        runId: `${label}-${stamp}`,
        sampleId: label,
        at: new Date().toISOString()
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(CaseExecutor.CaseExecutor)(executor), Layer.succeed(Runner.Runner)(scoring))
        )
      )

      // Per planned conversation: deterministic pass, judge pass.
      return run.cases.map((result, index): Outcome => {
        const plan = planned[index]!
        const observations = run.observations.filter((observation) => observation.case === result.case)
        const checks = observations.find((observation) => (observation.scorerName ?? "").includes("checks"))
        const judged = observations.find((observation) => (observation.scorerName ?? "").includes("judge"))
        const checksPass = checks?.kind === "score" &&
          (checks.meta as { readonly pass?: boolean } | undefined)?.pass === true
        const judgePass = judged === undefined ||
          (judged.kind === "score" && (judged.meta as { readonly pass?: boolean } | undefined)?.pass === true)
        return {
          plan,
          conversation: result.execution?.output as Conversation | undefined,
          error: result.error === undefined ? undefined : String(result.error.message),
          checksPass,
          judgePass,
          pass: checksPass && judgePass,
          failed: checks?.kind === "score"
            ? ((checks.meta as { readonly checks?: ReadonlyArray<Checks.Check> }).checks ?? []).filter((check) =>
              !check.pass
            )
            : [],
          judgeReason: judged?.kind === "score" ? judged.reason : judged?.reason
        }
      })
    })

  const lines: Array<string> = []
  let exitCode = reportLive && outcomes.some((outcome) => !outcome.pass) ? 1 : 0
  if (flag("coverage")) {
    const byRule = new Map<string, Array<string>>()
    for (const suiteCase of suite.cases) {
      for (const rule of suiteCase.tests) byRule.set(rule, [...(byRule.get(rule) ?? []), suiteCase.id])
    }
    const rules = [...byRule.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    lines.push("coverage (rule: cases):", ...rules.map((rule) => `  ${rule}: ${byRule.get(rule)!.length}`), "")
  }
  if (!reportLive) {
    for (const outcome of outcomes) {
      const expectedPass = outcome.plan.variant.kind === "golden"
      const ok = outcome.pass === expectedPass
      if (!ok) exitCode = 1
      lines.push(
        `${ok ? "✓" : "✗"} ${outcome.plan.suiteCase.id} ${variantName(outcome.plan.variant)}: ${
          outcome.pass ? "passes" : "fails"
        }${
          expectedPass
            ? ""
            : ` (must fail): ${outcome.failed.slice(0, 3).map((check) => check.id).join("; ")}${
              outcome.checksPass && !outcome.judgePass ? "judge" : ""
            }`
        }${
          outcome.pass || !expectedPass
            ? ""
            : `\n    ${outcome.failed.map((check) => `${check.id}: ${check.detail}`).join("\n    ")}${
              outcome.error === undefined ? "" : `\n    ${outcome.error}`
            }`
        }${!expectedPass && outcome.pass ? "\n    a counterexample passed: the case does not catch it" : ""}`
      )
    }
  }

  const perCase: Record<string, Array<boolean>> = {}
  for (const outcome of outcomes.filter((o) => o.plan.variant.kind === (reportLive ? "live" : "golden"))) {
    ;(perCase[outcome.plan.suiteCase.id] ??= []).push(outcome.pass)
  }
  const k = Math.max(1, trials)
  const aggregate = Trials.aggregate(perCase, k)
  const buckets = new Map<string, Record<string, Array<boolean>>>()
  for (const suiteCase of suite.cases) {
    const bucket = buckets.get(suiteCase.category) ?? {}
    if (perCase[suiteCase.id] !== undefined) bucket[suiteCase.id] = perCase[suiteCase.id]!
    buckets.set(suiteCase.category, bucket)
  }
  const byCategory = Object.fromEntries(
    [...buckets].filter(([, cases]) => Object.keys(cases).length > 0).map((
      [name, cases]
    ) => [name, Trials.aggregate(cases, k)])
  )

  const turnUsage = sum(
    outcomes.flatMap((outcome) => outcome.conversation?.turns.flatMap((turn) => turn.turn.usage) ?? [])
  )
  const judgeUse = sum(CharacterRubric.judgeUsage)
  const agentPercent = percent(turnUsage, weightsFor(seatId))
  const judgePercent = percent(judgeUse, weightsFor(suite.judgeSeat))

  const summary = {
    suite: suite.name,
    label,
    mode: rescoreFile !== undefined ? "rescored" : live ? "live" : "offline",
    seat: reportLive ? seatId : "replay",
    judge: judging ? suite.judgeSeat : undefined,
    profile: {
      file: profileFile ?? suite.profile,
      digest: composed.digest,
      bytes: composed.bytes
    },
    trials: k,
    at: new Date().toISOString(),
    cases: Object.keys(perCase).length,
    passAt1: aggregate.passAt1,
    passAtK: aggregate.passAtK,
    passHatK: aggregate.passHatK,
    allPass: aggregate.allPass,
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map((
        [name, value]
      ) => [name, { cases: value.cases, passAt1: value.passAt1, passHatK: value.passHatK }])
    ),
    usage: { agent: turnUsage, judge: judgeUse, agentPercentOfWeek: agentPercent, judgePercentOfWeek: judgePercent },
    failures: outcomes.filter((outcome) => !outcome.pass && outcome.plan.variant.kind !== "counterexample").map((
      outcome
    ) => ({
      case: outcome.plan.suiteCase.id,
      trial: outcome.plan.trial,
      checks: outcome.failed.map((check) => `${check.id}: ${check.detail}`),
      judge: outcome.checksPass ? outcome.judgeReason : undefined,
      error: outcome.error
    }))
  }

  if (reportLive) {
    const dir = join(suite.dir, "results")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${stamp}-${label}.json`)
    writeFileSync(
      file,
      JSON.stringify(
        {
          summary,
          conversations: outcomes.map((outcome) => ({
            case: outcome.plan.suiteCase.id,
            trial: outcome.plan.trial,
            pass: outcome.pass,
            checksPass: outcome.checksPass,
            judgePass: outcome.judgePass,
            judge: outcome.judgeReason,
            judgeKey: CharacterRubric.judgeKey(outcome.plan.suiteCase),
            failed: outcome.failed,
            turns: outcome.conversation?.turns.map((turn) => ({
              trigger: turn.trigger,
              reply: turn.turn.reply,
              failure: turn.turn.failure,
              actions: turn.turn.actions,
              modelCalls: turn.turn.modelCalls,
              usage: sum(turn.turn.usage),
              durationMs: turn.turn.durationMs
            }))
          }))
        },
        null,
        1
      )
    )
    const log = join(suite.dir, "REGRESSION-LOG.md")
    if (!existsSync(log)) {
      writeFileSync(
        log,
        "# Regression log\n\n| When | Label | Seat | Profile | Cases × trials | pass@1 | pass^k | Usage (% week) |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n"
      )
    }
    appendFileSync(
      log,
      `| ${summary.at.slice(0, 16)} | ${label} | ${seatId} | ${
        composed.digest.slice(0, 12)
      } | ${summary.cases} × ${k} | ${(summary.passAt1 * 100).toFixed(0)}% | ${
        (summary.passHatK * 100).toFixed(0)
      }% | ${((agentPercent ?? 0) + (judgePercent ?? 0)).toFixed(3)} |\n`
    )
    const pct = (value: number) => `${(value * 100).toFixed(0)}%`
    const table = [
      `# ${suite.name}: ${label}`,
      "",
      `${summary.at.slice(0, 16)} · seat ${seatId} · judge ${
        summary.judge ?? "off"
      } · ${summary.cases} cases × ${k} trials · profile ${composed.digest.slice(0, 12)}`,
      "",
      "| Category | Cases | pass@1 | pass^k |",
      "| --- | --- | --- | --- |",
      ...Object.entries(summary.byCategory).map(([name, value]) =>
        `| ${name} | ${value.cases} | ${pct(value.passAt1)} | ${pct(value.passHatK)} |`
      ),
      `| **all** | ${summary.cases} | **${pct(summary.passAt1)}** | **${pct(summary.passHatK)}** |`,
      "",
      `Usage: ${((agentPercent ?? 0) + (judgePercent ?? 0)).toFixed(3)}% of the weekly limit (agent ${
        (agentPercent ?? 0).toFixed(3)
      }%, judge ${(judgePercent ?? 0).toFixed(3)}%).`,
      "",
      "| Case | Category | Passed |",
      "| --- | --- | --- |",
      ...suite.cases.filter((c) => perCase[c.id] !== undefined).map((c) =>
        `| ${c.id} | ${c.category} | ${perCase[c.id]!.filter(Boolean).length}/${perCase[c.id]!.length} |`
      ),
      "",
      "## Failures",
      "",
      ...summary.failures.map((failure) =>
        `- **${failure.case}** (trial ${failure.trial}): ${
          [
            ...failure.checks,
            ...(failure.judge === undefined ? [] : [`judge: ${failure.judge}`]),
            ...(failure.error === undefined ? [] : [failure.error])
          ].join("; ").replaceAll("\n", " ")
        }`
      )
    ].join("\n")
    writeFileSync(file.replace(/\.json$/, ".md"), `${table}\n`)
    lines.push(`results: ${file}`)
  }

  process.stdout.write(
    `${lines.join("\n")}\n\n${JSON.stringify({ ...summary, failures: summary.failures.slice(0, 40) }, null, 1)}\n`
  )
  return exitCode
})

const exitCode = await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        process.stderr.write(`${Cause.pretty(cause)}\n`)
        return 5
      })
    )
  )
)
process.exit(exitCode)
