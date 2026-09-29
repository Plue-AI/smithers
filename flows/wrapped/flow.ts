/**
 * `wrapped`: the factory's agent step when the seat is an external harness.
 *
 * A launch runs Memory (the selection a native frame 0 runs), then Prompt,
 * which writes the extra prompt content-addressed and records the session it
 * is about to start, then Launch, which hands the prompt to the harness
 * through the harness's own mechanism with the task on stdin. The record is
 * written before the irreversible launch, so a launch never runs without one.
 * A resume runs no new selection: Recall reads that record and replays the
 * recorded bytes, so the appended prompt stays byte-identical and the
 * follow-up goes on stdin. A host supplies the implementations with
 * {@link layer}.
 */
import * as Memory from "@smthrs/agent/Memory"
import { Action, Flow } from "@smthrs/flow"
import { Capability } from "@smthrs/flows"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { launch, type LaunchOptions, WrappedFailed } from "./launch.ts"
import { defaultPermission, extraPrompt, Harness, maxExtraBytes, Permission, promptPath, sha256 } from "./prompt.ts"

export { WrappedFailed }

/** The memory budget, the same default a `ctx.call("memory")` uses. */
export const maxBytes = 32 * 1024

export const Extra = Schema.Struct({ path: Schema.String, digest: Schema.String, bytes: Schema.Int })
/** What memory put in the prompt; `unjudged` is set when Jev was down, slow or absent. */
export const MemorySummary = Schema.Struct({
  digest: Schema.String,
  kept: Schema.Int,
  cost: Memory.Output.fields.cost,
  unjudged: Memory.Output.fields.unjudged
})
export type MemorySummary = typeof MemorySummary.Type
export const Prepared = Schema.Struct({
  session: Schema.String,
  permission: Permission,
  extra: Extra,
  memory: MemorySummary
})
export type Prepared = typeof Prepared.Type
export const Success = Schema.Struct({ answer: Schema.String, ...Prepared.fields })
export type Success = typeof Success.Type

const payload = {
  harness: Harness,
  task: Schema.String,
  cwd: Schema.String,
  session: Schema.optional(Schema.String),
  /** A new launch's permission mode, `acceptEdits` by default. A resume keeps the recorded one. */
  permission: Schema.optional(Permission)
}
export type Payload = Schema.Struct<typeof payload>["Type"]

export const SelectMemory = Action.make("wrapped/memory", {
  payload: { task: Schema.String, cwd: Schema.String },
  success: Memory.Output,
  error: Memory.MemoryFailed,
  nondeterministic: true
})
export const WritePrompt = Action.make("wrapped/prompt", {
  payload: { task: Schema.String, cwd: Schema.String, permission: Permission, memory: Memory.Output },
  success: Prepared,
  error: WrappedFailed,
  nondeterministic: true
})
export const Recall = Action.make("wrapped/session", {
  payload: { cwd: Schema.String, session: Schema.String, permission: Schema.optional(Permission) },
  success: Prepared,
  error: WrappedFailed
})
export const Launch = Action.make("wrapped/launch", {
  payload: { harness: Harness, task: Schema.String, cwd: Schema.String, resume: Schema.Boolean, prepared: Prepared },
  success: Success,
  error: WrappedFailed,
  tier: "irreversible"
})

/** A launch selects memory and writes the prompt; a resume replays the recorded prompt. */
const prepare = ({ cwd, permission, session, task }: Payload) =>
  session === undefined
    ? SelectMemory.call({ task, cwd }).pipe(
      Node.bindPlanned((memory) => WritePrompt.call({ task, cwd, permission: permission ?? defaultPermission, memory }))
    )
    : Recall.call({ cwd, session, ...(permission === undefined ? {} : { permission }) })
type Prepare = ReturnType<typeof prepare>

export default Flow.make("wrapped", {
  description:
    "Run Claude Code on a task with the memory a native agent starts with and the shared Smithers prompt appended through its own mechanism.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload,
  success: Success,
  error: Schema.Union([Memory.MemoryFailed, WrappedFailed]),
  body: (input) =>
    (prepare(input) as Node.Node<Prepared, Node.Error<Prepare>, Node.Services<Prepare>>).pipe(
      Node.bindPlanned((prepared) =>
        Launch.call({
          harness: input.harness,
          task: input.task,
          cwd: input.cwd,
          resume: input.session !== undefined,
          prepared
        })
      )
    )
})

/**
 * The grants a runtime host passes for this flow. Memory reads `cwd` through
 * the engine's guarded filesystem, runs jj/git for commits and notes, and asks
 * Jev through the gateway. Without them memory fails with `read_failed`.
 * The prompt and session writes and the harness spawn use `node:fs` and
 * `node:child_process` directly, outside these grants.
 */
export const grants = (cwd: string) => {
  const rule = (action: "fs:read" | "proc:spawn" | "model:call", resource: string) =>
    new Capability.Permission.Rule({
      effect: "allow",
      pattern: new Capability.Capability.CapabilityPattern({ action, resource })
    })
  return [
    rule("fs:read", cwd),
    rule("fs:read", `${cwd}/*`),
    rule("proc:spawn", "jj *"),
    rule("proc:spawn", "git *"),
    rule("model:call", `ai-gateway.vercel.sh/${Evaluator.defaultModel}`)
  ]
}

/** Selects memory for `task` in `cwd`: the host's frame-0 selection at {@link maxBytes}, judged by the host's Evaluator. */
export const selectMemory = (task: string, cwd: string) =>
  Effect.andThen(
    Effect.service(Evaluator.Evaluator),
    Effect.map(Memory.select({ task, maxBytes }, { root: cwd }), (selection) => selection.output)
  )

/** The summary a launch reports and records for `output`. */
export const summarize = (output: Memory.Output): MemorySummary => ({
  digest: output.digest,
  kept: output.kept.length,
  cost: output.cost,
  ...(output.unjudged === undefined ? {} : { unjudged: output.unjudged })
})

/**
 * Writes the extra prompt at its content address and picks the new session's
 * id. A prompt no argv can carry (a NUL byte, or over {@link maxExtraBytes})
 * fails `prompt_unsendable` before anything is written or recorded. The write
 * goes to a temporary name and is renamed into place, so a concurrent launch of
 * the same bytes never reads a truncated file and a live session's prompt
 * never changes.
 */
export const writePrompt = (input: {
  readonly cwd: string
  readonly permission: Permission
  readonly memory: Memory.Output
}): Effect.Effect<Prepared, WrappedFailed> => {
  const text = extraPrompt({ permission: input.permission, memory: input.memory })
  const digest = sha256(text)
  const path = promptPath(input.cwd, digest)
  const refused = (message: string) => Effect.fail(new WrappedFailed({ code: "prompt_unsendable", message }))
  if (text.includes("\0")) return refused("the extra prompt holds a NUL byte, which no argv can carry")
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > maxExtraBytes) {
    return refused(`the extra prompt is ${bytes} bytes, over the ${maxExtraBytes}-byte argv bound`)
  }
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, text, "utf8")
      await rename(temporary, path)
    },
    catch: (cause) => new WrappedFailed({ code: "prompt_failed", message: String(cause) })
  }).pipe(Effect.as({
    session: randomUUID(),
    permission: input.permission,
    extra: { path, digest, bytes },
    memory: summarize(input.memory)
  }))
}

/** `<cwd>/.flows/wrapped/sessions/<session>.json`, or `undefined` for an id that is not a plain file name. */
export const sessionPath = (cwd: string, session: string): string | undefined =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session)
    ? join(cwd, ".flows", "wrapped", "sessions", `${session}.json`)
    : undefined

/** The record names the prompt by digest only; its path follows from `cwd`, so a moved checkout still resumes. */
const SessionRecord = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  memory: MemorySummary,
  permission: Permission,
  task: Schema.String
})

/** Records what a launch appends, as deterministic JSON (sorted keys, trailing newline). */
export const recordSession = (cwd: string, task: string, prepared: Prepared): Effect.Effect<void, WrappedFailed> => {
  const path = sessionPath(cwd, prepared.session)
  if (path === undefined) {
    return Effect.fail(
      new WrappedFailed({ code: "session_unknown", message: `unusable session id ${JSON.stringify(prepared.session)}` })
    )
  }
  const { cost, digest, kept, unjudged } = prepared.memory
  const record = {
    digest: prepared.extra.digest,
    memory: {
      cost: { candidates: cost.candidates, jevMs: cost.jevMs, jevRequests: cost.jevRequests },
      digest,
      kept,
      ...(unjudged === undefined ? {} : { unjudged: { detail: unjudged.detail, reason: unjudged.reason } })
    },
    permission: prepared.permission,
    task
  }
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    },
    catch: (cause) => new WrappedFailed({ code: "session_record_failed", message: String(cause) })
  })
}

/**
 * Reads a launch's record and its extra prompt back, refusing a record that
 * is malformed, a prompt that moved, or a permission mode other than the
 * recorded one.
 */
export const recallSession = (
  cwd: string,
  session: string,
  permission?: Permission | undefined
): Effect.Effect<Prepared, WrappedFailed> =>
  Effect.gen(function*() {
    const unknown = (message: string) => new WrappedFailed({ code: "session_unknown", message })
    const path = sessionPath(cwd, session)
    if (path === undefined) return yield* unknown(`unusable session id ${JSON.stringify(session)}`)
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => unknown(`no launch recorded session ${session} under ${cwd}`)
    })
    const record = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SessionRecord)(JSON.parse(text)),
      catch: () => new WrappedFailed({ code: "session_malformed", message: `${path} is not a session record` })
    })
    if (permission !== undefined && permission !== record.permission) {
      return yield* new WrappedFailed({
        code: "permission_changed",
        message: `session ${session} launched under ${record.permission}, not ${permission}`
      })
    }
    const extraPath = promptPath(cwd, record.digest)
    const extra = yield* Effect.tryPromise({
      try: () => readFile(extraPath, "utf8"),
      catch: () => new WrappedFailed({ code: "extra_changed", message: `${extraPath} is gone` })
    })
    if (sha256(extra) !== record.digest) {
      return yield* new WrappedFailed({
        code: "extra_changed",
        message: `${extraPath} changed since the launch`
      })
    }
    return {
      session,
      permission: record.permission,
      extra: { path: extraPath, digest: record.digest, bytes: Buffer.byteLength(extra, "utf8") },
      memory: record.memory
    }
  })

/**
 * The implementations of the four steps. Memory needs FileSystem, Path, a
 * spawner and an Evaluator. `onMemory` receives the selection the prompt uses.
 */
export const layer = (
  options: LaunchOptions & { readonly onMemory?: ((output: Memory.Output) => void) | undefined } = {}
) =>
  Layer.mergeAll(
    SelectMemory.toLayer(({ cwd, task }) =>
      selectMemory(task, cwd).pipe(Effect.tap((output) => Effect.sync(() => options.onMemory?.(output))))
    ),
    WritePrompt.toLayer(({ task, ...input }) =>
      Effect.tap(writePrompt(input), (prepared) => recordSession(input.cwd, task, prepared))
    ),
    Recall.toLayer(({ cwd, permission, session }) => recallSession(cwd, session, permission)),
    Launch.toLayer(({ prepared, resume, ...input }) =>
      launch({ ...input, ...prepared, resume }, options).pipe(
        Effect.map(({ answer }) => ({ answer, ...prepared }))
      )
    )
  )
