/** Machine-only learning: reuse mining without its direct file/note writes.
 * The host consumes typed output in one transaction; this flow has no write door.
 */
import * as MemoryMine from "@smthrs/agent/MemoryMine"
import { Action, Fault, Flow } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Context, Effect, Layer, Schema } from "effect"

const Text = Schema.NonEmptyString
const Todo = Schema.Int.check(Schema.isGreaterThan(0))
export const Failure = Schema.Struct({ signature: Text, text: Text })
export const Outcome = Schema.Struct({ todo: Todo, failures: Schema.Array(Failure) })
export const Snapshot = Schema.Struct({
  repository: Text, todo: Todo, run: Text, state: Schema.Literal("merged"),
  change: Text, commit: Text, attempts: Schema.Array(Text),
  journal: Schema.Array(MemoryMine.Row), outcomes: Schema.Array(Outcome)
})
export type Snapshot = typeof Snapshot.Type
export const Output = Schema.Struct({
  repository: Text, todo: Todo, run: Text,
  pages: Schema.Array(Schema.Struct({ title: Text, body: Text })),
  proposals: Schema.Array(Schema.Struct({
    signature: Text, title: Text, evidence: Schema.Array(Text), todos: Schema.Array(Todo), prompt: Text
  }))
})
export type Output = typeof Output.Type
export class LearningFailed extends Schema.TaggedError<LearningFailed>()("learning/Failed", {
  code: Schema.Literals(["unavailable", "invalid_input", "judge_failed"]), message: Text
}) {}
Fault.register("learning/Failed", {
  unavailable: "dependency", invalid_input: "bug", judge_failed: "dependency"
} satisfies Fault.Rows<LearningFailed["code"]>)

/** Run-credential reads are supplied only inside the isolated machine. No local fallback. */
export class Binding extends Context.Service<Binding, {
  readonly read: (todo: number) => Effect.Effect<Snapshot, LearningFailed>
}>()("learning/Binding") {}

/** Count distinct merged TODOs, not attempts, from the bounded outcome window. */
export const evidence = (outcomes: Snapshot["outcomes"]) => {
  const window = outcomes.slice(-20)
  const signatures = [...new Set(window.flatMap(row => row.failures.map(f => f.signature)))].sort()
  return signatures.map(signature => {
    const todos = [...new Set(window.filter(row => row.failures.some(f => f.signature === signature)).map(row => row.todo))]
    return { signature, todos, count: `${todos.length} of the last ${window.length}` }
  })
}

export const learn = (snapshot: Snapshot) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknownEffect(Snapshot)(snapshot).pipe(
    Effect.mapError(error => new LearningFailed({ code: "invalid_input", message: error.message }))
  )
  if (input.outcomes.length > 20 || new Set(input.outcomes.map(row => row.todo)).size !== input.outcomes.length)
    return yield* Effect.fail(new LearningFailed({ code: "invalid_input", message: "Expected at most 20 distinct merged TODOs" }))
  const extracted = MemoryMine.extract(input.journal)
  const judged = yield* MemoryMine.judge(`T${input.todo}`, extracted.candidates).pipe(
    Effect.mapError(error => new LearningFailed({ code: "judge_failed", message: `${error.reason}: ${error.detail}` }))
  )
  // Only Jev-approved issues with recorded failure evidence become proposals.
  const proposals = evidence(input.outcomes).flatMap(pattern => {
    const finding = input.outcomes.flatMap(row => row.failures).find(f => f.signature === pattern.signature)
    const issue = judged.issues.find(candidate => finding && MemoryMine.normalize(candidate.text) === MemoryMine.normalize(finding.text))
    return issue ? [{ signature: pattern.signature, title: issue.text,
      evidence: [`${pattern.count} failed ${pattern.signature}`], todos: pattern.todos, prompt: issue.text }] : []
  })
  const pages = extracted.decisions.length === 0 ? [] : [{
    title: `T${input.todo} decisions`,
    body: [`Change: ${input.change}`, `Commit: https://github.com/${input.repository}/commit/${input.commit}`,
      ...input.attempts.map(run => `Run: ${run}`),
      ...extracted.decisions.map(decision => `- ${decision.text} (learning ${input.run}, evidence seq ${decision.seq})`)].join("\n")
  }]
  return { repository: input.repository, todo: input.todo, run: input.run, pages, proposals } satisfies Output
})
export const Run = Action.make("learning/run", {
  payload: { todo: Todo }, success: Output, error: LearningFailed, nondeterministic: true
})
export default Flow.make("learning", {
  description: "Read merged TODO evidence and return decision pages and proposals.",
  capabilities: ["model:call:typesafe-ai/jev"],
  effects: { reads: ["todo/**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  modelInvocable: false, payload: { todo: Todo }, success: Output, error: LearningFailed,
  body: input => Run.call(input)
})
export const layer = Layer.unwrap(Effect.gen(function*() {
  const binding = yield* Binding
  const evaluator = yield* Evaluator.Evaluator
  return Run.toLayer(({ todo }) => Effect.gen(function*() {
    const snapshot = yield* binding.read(todo)
    if (snapshot.todo !== todo) return yield* Effect.fail(new LearningFailed({ code: "invalid_input", message: "Wrong TODO" }))
    return yield* learn(snapshot).pipe(Effect.provideService(Evaluator.Evaluator, evaluator))
  }))
}))
