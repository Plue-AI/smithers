/**
 * The one judge a native test host runs, scripted from the evidence instead of
 * requested from a subscription seat.
 *
 * These fixtures build a whole configured host — plan, cell, guarded writes,
 * checks, repository jobs — and every one of those readers asks Jev. A host
 * binds the subscription judge or explicitly supplies a scripted evaluator.
 * These fixtures script every classifier the host reaches, so the completion
 * brake and repository decisions still read their evidence.
 *
 * `NativeControl.Platform.evaluator` is the seam `flows/coding/host.ts`
 * prefers over `evaluatorLayer(process.env)` for the
 * agent loop and for every repository reader, so a host never runs two judges.
 *
 * ## Scripted, not permissive
 *
 * A layer that answers "complete" to everything satisfies the compiler and
 * deletes the brake. Every answer here is computed from the state the
 * classifier sends, and `coding-host-native.test.ts` drives the brake's own
 * `CompletionClaim.read` with this judge over a claim it must refuse.
 * The completion brake's verdict rides on one question — does the claim report
 * a command or a result this run's record does not record — and
 * {@link reportsUnrecordedWork} answers that one by reading the claim against
 * `checksRun` and `lastCheck`, so a fixture whose cell starts inventing a test
 * run fails exactly as a live host would.
 *
 * ## One judge, many classifiers
 *
 * A composition holds one `Evaluator`, and the host's readers do not share a
 * question set. The script therefore dispatches on the question ids it was
 * handed, and answers **by id**: a scripted answer map missing an id the
 * classifier asked fails the whole evaluation as `invalid_answer`, which
 * reaches the brake as `completion_unjudged` and reads like a defect in
 * whatever the case was actually about. Question ids this fixture scripts no
 * answer for fail with the explicit outage reply, `unreachable`, so no assertion
 * anywhere starts passing because a fixture said yes.
 *
 * @since 1.0.0-rc.0
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === "string" ? value : ""
const list = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

/** What this fixture answers to any question it does not script. The message is the transport's own so a journal line, a
 * refused check row and a test all read the same words. */
export const unscripted = (detail: string): Evaluator.EvaluatorError =>
  new Evaluator.EvaluatorError({ code: "unreachable", message: `No evaluator is installed on this host (${detail})` })

/**
 * Whether one completion claim reports work this run's record does not record.
 *
 * This is the whole verdict the completion brake still acts on, so it is read
 * from the evidence rather than declared. A claim reports work when it both
 * speaks of a run or its outcome — `ran`, `passed`, `exits`, `output` — and
 * names something to run: a backticked span, or a runner and its arguments.
 * The record is every command in `checksRun` plus the completing frame's
 * `lastCheck`. A named command the record carries on either side of a
 * containment is recorded; one it carries nowhere is the refusal.
 *
 * A mention with no run or result around it is not a report. A proposed
 * fixture's `argv`, a path that happens to end in `.mjs`, or a cited file are
 * all things a run is entitled to write about work it has not done, and the
 * question this answers is deliberately narrower than "is the claim true".
 */
export const reportsUnrecordedWork = (evidence: {
  readonly claim: string
  readonly checksRun: ReadonlyArray<{ readonly command: string }>
  readonly lastCheck?: { readonly command: string } | undefined
}): boolean => {
  const claim = evidence.claim
  if (!/\b(ran|run|runs|passed|passes|passing|failed|fails|executed|exited|exits|output|succeeded|green)\b/i.test(claim)) {
    return false
  }
  const named = [
    ...[...claim.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!),
    ...[...claim.matchAll(/\b(?:node|npm|pnpm|bun|yarn|python3?|cargo|make|jj|git|bash|sh|pytest|vitest|jest|tsc)\b[^\n"'`,;)}\]]*/g)]
      .map(match => match[0]!)
  ].map(value => value.trim()).filter(value => value !== "")
  if (named.length === 0) return false
  const record = [...evidence.checksRun.map(check => check.command), ...(evidence.lastCheck ? [evidence.lastCheck.command] : [])]
  return named.some(command => !record.some(entry => entry.includes(command) || command.includes(entry)))
}

/**
 * The completion brake's five answers, from one reading of one evidence
 * record.
 *
 * `invented` is the only one with a verdict behind it, and it is
 * {@link reportsUnrecordedWork}. `complete` and `overclaims` are bounce
 * heights that decide nothing — `CompletionClaim`'s own corpus demoted them
 * because neither separates an honest completion from a lie — so they are
 * answered consistently with the one reading rather than independently: a
 * claim that reports work nothing recorded is also a claim that overclaims and
 * has not shown the task done, and a claim that does not is neither. Answering
 * them at no demand keeps a fixture's measured model-call counts honest, since
 * a bounce spends a frame that a fixed script would answer with the same
 * sentence.
 */
const completion = (state: unknown): Record<string, Evaluator.ScriptedAnswer> => {
  const evidence = object(state)
  const unrecorded = reportsUnrecordedWork({
    claim: text(evidence["claim"]),
    checksRun: list(evidence["checksRun"]).map(check => ({ command: text(object(check)["command"]) })),
    lastCheck: evidence["lastCheck"] === undefined ? undefined : { command: text(object(evidence["lastCheck"])["command"]) }
  })
  return {
    complete: { probability: unrecorded ? 0.05 : 0.95 },
    overclaims: { probability: unrecorded ? 0.95 : 0.05 },
    invented: { probability: unrecorded ? 0.95 : 0.02 },
    // This offline fixture makes no inference about completion intent.
    requiresWorkspaceChange: { probability: 0.5 },
    reportsLimitation: { probability: 0 }
  }
}

/**
 * The intake screen's three answers about one inbound text.
 *
 * `injection` is read for what its criteria describe: text that addresses a
 * model or tells its reader to change its rules, reveal its prompt or run
 * something. Nothing else in a fixture's issue body makes it an injection, and
 * a fixture that plants one is still caught.
 *
 * `kind` never answers `spam` or `irrelevant` for a text that names something
 * to do, because that answer is the one the screen acts on: at or above
 * `ignoreConfidence` it drops the event and selects no step. A text that asks
 * is a question, one that reports something going wrong is a bug, and one that
 * asks for a change is a feature.
 */
const intake = (state: unknown): Record<string, Evaluator.ScriptedAnswer> => {
  const event = object(state)
  const body = `${text(event["title"])}\n${text(event["body"])}`
  const injection = /\b(ignore (all |your )?(previous|prior|earlier) instructions|you are (now )?an? (ai|assistant|agent)|system prompt|reveal your|disregard the above)\b/i
    .test(body)
  const kind = body.trim() === "" ? "irrelevant"
    : /\b(reproduce|reproduction|broken|regression|wrong|fails|crash|defect|bug)\b/i.test(body) ? "bug"
    : /\?|^\s*(what|how|why|which|where|does|is|can)\b/i.test(body) ? "question"
    : /\b(add|remove|delete|change|use|rename|support|try|implement|introduce)\b/i.test(body) ? "feature"
    : "question"
  return {
    injection: { probability: injection ? 0.97 : 0.02 },
    kind: { choice: kind },
    // Middle rung: a fixture's text carries no deadline, and the score steers
    // nothing the host branches on.
    urgency: { score: 1 }
  }
}

/**
 * Whether one changed hunk violates one maintainer rule.
 *
 * A fixture writes its rule in the maintainer's place, and these fixtures
 * write rules that state the judgment they are testing: `Fixture: captured
 * context fail` is a rule a hunk violates, `Fixture: captured context pass` is
 * one it keeps. So the script reads the rule, which is what judging a rule
 * means here; no scripted reasoning over a diff would be more honest than the
 * rule's own words. `Fixture: telemetry context is unavailable` is neither
 * answer: it declares that the evidence this rule needs is missing, so the
 * judge answers the way a judge with nothing to read answers, and the check
 * errors as `unavailable` rather than passing.
 *
 * A rule that states no fixture verdict — the built-in `implementation-review`
 * among them — is answered `false`, cleanly below `CLEAN_PROBABILITY`: these
 * fixtures' proposals are the change their own task asked for.
 */
const rule = (state: unknown): Record<string, Evaluator.ScriptedAnswer> | Evaluator.EvaluatorError => {
  const asked = text(object(state)["rule"])
  if (/unavailable/i.test(asked)) return unscripted(`this fixture's rule declares its evidence unavailable: ${asked}`)
  return { violates: { probability: /\bfail\b/i.test(asked) ? 0.95 : 0.05 } }
}

/**
 * Whether a recorded job met the maintainer's frozen expectation.
 *
 * Read as a containment, not as an opinion: the expectation names what the
 * job had to establish, and the job's own recorded summaries and evidence
 * references either carry those words or do not. Every word of four letters
 * or more in the expectation must appear somewhere in what the job recorded;
 * a missing one is a `fail`, and a job that recorded no step at all is a
 * `review`.
 */
const evaluationCase = (state: unknown): Record<string, Evaluator.ScriptedAnswer> => {
  const judged = object(state)
  const observed = object(judged["observed"])
  const steps = list(observed["results"]).map(step => object(step))
  if (steps.length === 0) return { verdict: { choice: "review" } }
  const recorded = steps
    .map(step => `${text(step["status"])} ${text(step["summary"])} ${list(step["evidence"]).map(text).join(" ")}`)
    .join("\n").toLowerCase()
  const wanted = text(judged["expected"]).toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []
  const missing = wanted.filter(word => word !== "held_out_expectation" && !recorded.includes(word))
  return { verdict: { choice: missing.length === 0 ? "pass" : "fail" } }
}

/**
 * Whether an executed reproduction demonstrates the defect it reports.
 *
 * The discriminator is the one the classifier's own criteria name: a fixture
 * that never invokes the repository's behaviour cannot establish a defect in
 * it, however loudly it fails. `source` lists the captured repository source
 * this job holds, and the fixture's own text either reaches into it — by path
 * or by the final segment an import writes — or it does not. A fixture that
 * names none is the criteria's own example of `unrelated`, an unconditional
 * throw, whatever it prints. One that does name captured source and whose
 * measured run failed carrying the failure text the report named
 * `demonstrates` it, and everything in between is `uncertain`.
 */
const reproduction = (state: unknown): Record<string, Evaluator.ScriptedAnswer> => {
  const judged = object(state)
  const command = object(judged["command"])
  const measured = object(judged["measured"])
  const written = list(judged["fixture"]).map(file => text(object(file)["content"])).join("\n")
  const reaches = list(judged["source"]).map(text).filter(path => path !== "").some(path => {
    const segment = path.split("/").filter(part => part !== "").at(-1)
    return written.includes(path) || (segment !== undefined && segment !== "" && written.includes(segment))
  })
  if (!reaches) return { verdict: { choice: "unrelated" } }
  const expected = text(command["failureContains"])
  const printed = `${text(measured["stdout"])}\n${text(measured["stderr"])}`
  const failed = measured["exitCode"] !== 0
  return { verdict: { choice: failed && expected !== "" && printed.includes(expected) ? "demonstrates" : "uncertain" } }
}

/**
 * How close a prior record is to the request under investigation.
 *
 * Scripted as a word overlap of the two titles rather than a verdict: the
 * rung this fixture may not hand out for free is the last one, `same`, which
 * is the only one that makes a prior record a duplicate.
 */
const duplicates = (state: unknown): Record<string, Evaluator.ScriptedAnswer> => {
  const judged = object(state)
  const words = (value: unknown) => new Set((text(value).toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []))
  const subject = words(object(judged["subject"])["title"])
  const candidate = words(object(judged["candidate"])["title"])
  const shared = [...candidate].filter(word => subject.has(word)).length
  const width = Math.max(subject.size, candidate.size, 1)
  return { score: { score: shared === width ? 2 : shared / width >= 0.5 ? 1 : 0 } }
}

/**
 * Whether one cited source excerpt supports the claim it is cited for.
 *
 * Read as bearing, which is the one part of this question a script can settle
 * honestly: an excerpt that carries a word of the claim bears on it, and one
 * that carries none does not. `contradicts` is never answered, because no
 * script here reads a negation.
 *
 * The default is the strict one. `unrelated` makes the citation unsupported,
 * which makes the page unsupported, which refuses the run — so a wiki fixture
 * whose reviewer starts citing source that has nothing to do with its claim
 * fails here rather than publishing.
 */
const citation = (state: unknown): Record<string, Evaluator.ScriptedAnswer> => {
  const judged = object(state)
  const excerpt = text(object(judged["source"])["excerpt"]).toLowerCase()
  const claimed = text(judged["claim"]).toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []
  return { support: { choice: claimed.some(word => excerpt.includes(word)) ? "supports" : "unrelated" } }
}

const has = (questions: Readonly<Record<string, unknown>>, ...ids: ReadonlyArray<string>) =>
  ids.length === Object.keys(questions).length && ids.every(id => id in questions)

/**
 * One judge, and what it was asked.
 *
 * `rulesJudged` is the maintainer rule of every `check/rule` evaluation this
 * judge answered, in order. A host's AI check is Jev and no longer a seat, so
 * this is where a case proves that a reviewer was spent on an available
 * context and was not spent on a missing one — the property the model-call
 * counters used to carry before `3638d4ef09fa` moved AI checks to Jev.
 *
 * @category fixtures
 */
export interface HostJudge {
  readonly layer: Layer.Layer<Evaluator.Evaluator>
  readonly rulesJudged: ReadonlyArray<string>
}

/**
 * The judge a native test host binds through `NativeControl.Platform.evaluator`.
 *
 * One layer, every classifier this host asks, dispatched by question id. The
 * agent's own relevance, compaction, routing and supervisor readings are
 * answered by `ScriptedJudge.answer`. A question set neither scripts fails
 * closed.
 * One per host, so what one case asked is not another's.
 *
 * @category fixtures
 */
export const makeHostJudge = (): HostJudge => {
  const rulesJudged: Array<string> = []
  const layer = Evaluator.layerScripted(request => {
    const questions = request.questions
    if (has(questions, "complete", "overclaims", "invented", "requiresWorkspaceChange", "reportsLimitation")) {
      return completion(request.state)
    }
    if (has(questions, "injection", "kind", "urgency")) return intake(request.state)
    if (has(questions, "violates")) {
      const answered = rule(request.state)
      if (answered instanceof Evaluator.EvaluatorError) return Effect.fail(answered)
      rulesJudged.push(text(object(request.state)["rule"]))
      return answered
    }
    if (has(questions, "verdict")) {
      return "measured" in object(request.state) ? reproduction(request.state) : evaluationCase(request.state)
    }
    if (has(questions, "score")) return duplicates(request.state)
    if (has(questions, "support")) return citation(request.state)
    const agent = ScriptedJudge.answererFor(Object.keys(questions))
    if (agent !== undefined) return agent(request)
    return Effect.fail(unscripted(`this fixture scripts no answer for ${Object.keys(questions).sort().join(", ")}`))
  })
  return { layer, rulesJudged }
}
