import { NodeServices } from "@effect/platform-node"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Graph, HumanTask } from "@smthrs/flow"
import * as DurableDeferred from "@smthrs/flow/DurableDeferred"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isDeepStrictEqual, parseArgs } from "node:util"
import ReleaseContent from "../release-content/flow.ts"
import Release from "../release/flow.ts"
import { contentInput, releaseInput } from "./input.ts"
import { atomicWrite, inside, maybeRead } from "./io.ts"
import { runtime } from "./runtime.ts"
import { ContentInput, ReleaseInput, StoredRun } from "./schema.ts"

const root = resolve(import.meta.dirname, "../..")
const help = `Smithers release workflows (Node 26.4+, pnpm and jj required)

pnpm release:content --input '{"version":"1.0.0-rc.0","from":"v0.35.0"}'
pnpm release:workflow --input '{"phase":"publish","version":"1.0.0-rc.0","contentArtifact":".flows/releases/content/..."}'

Both commands default to dryRun=true. --plan only builds the graph: no models,
registry calls, release writes or publication. dryRun=false enables the durable
human approval before writes/publication. --input-file accepts a JSON file.

--run <id>      Create/reopen a named run with the same input and model settings.
--resume <id>   Reopen the stored run without resupplying its input.
--model <seat>  Use the CLI provider seat (default openai:gpt-6-sol).
--max-tokens N  Total model token budget (default 250000).

pnpm release:status <id>          Read stored status without starting the engine.
pnpm release:answer <id> true     Approve the current human task and resume.
pnpm release:answer <id> false    Decline the current human task and resume.

Runs and SQLite journals live in .flows/releases/runs/<id>/.
`

const readStored = async (record: string): Promise<StoredRun> =>
  Schema.decodeUnknownSync(StoredRun)(JSON.parse(await readFile(record, "utf8")))
const idOf = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(value)) {
    throw new Error("Run IDs may contain only letters, numbers, hyphens and underscores")
  }
  return value
}
const paths = (id: string) => {
  const directory = `.flows/releases/runs/${idOf(id)}`
  return { directory, record: `${directory}/run.json`, filename: join(root, directory, "engine.db") }
}
const report = async (id: string, result: unknown) => {
  const review = await maybeRead(await inside(root, `${paths(id).directory}/review.json`))
  process.stdout.write(
    JSON.stringify({ ...result as object, ...(review ? { review: JSON.parse(review) } : {}) }, null, 2) + "\n"
  )
}
const statusEffect = (id: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    const run = yield* store.get(id)
    const waiting = yield* state.waiting(id)
    return { id, status: run.status, waiting: Option.getOrNull(waiting) }
  })

const drive = (stored: StoredRun, answer?: boolean) =>
  Effect.gen(function*() {
    if (answer !== undefined) {
      const state = yield* DurableEngineState.DurableEngineState
      const waiting = yield* state.waiting(stored.id)
      if (
        Option.isNone(waiting) || waiting.value.reason !== "approval" || waiting.value.token === null
      ) return yield* Effect.die("This run is not waiting for a human approval")
      yield* HumanTask.answer({
        token: Schema.decodeUnknownSync(DurableDeferred.Token)(waiting.value.token),
        value: answer
      })
    }
    if (stored.kind === "release") {
      yield* Release.execute(Schema.decodeUnknownSync(ReleaseInput)(stored.input), {
        executionId: stored.id,
        discard: true
      })
      const result = yield* Release.poll(stored.id)
      if (Option.isSome(result) && result.value._tag === "Complete") {
        if (Exit.isFailure(result.value.exit)) return yield* Effect.failCause(result.value.exit.cause)
        return { id: stored.id, result: result.value.exit.value }
      }
    } else {
      yield* ReleaseContent.execute(Schema.decodeUnknownSync(ContentInput)(stored.input), {
        executionId: stored.id,
        discard: true
      })
      const result = yield* ReleaseContent.poll(stored.id)
      if (Option.isSome(result) && result.value._tag === "Complete") {
        if (Exit.isFailure(result.value.exit)) return yield* Effect.failCause(result.value.exit.cause)
        return { id: stored.id, result: result.value.exit.value }
      }
    }
    return yield* statusEffect(stored.id)
  })

export const main = async (argv: ReadonlyArray<string>) => {
  const command = argv[0]
  if (argv.includes("--help") || command === undefined) {
    process.stdout.write(help)
    return
  }
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      input: { type: "string" },
      "input-file": { type: "string" },
      run: { type: "string" },
      resume: { type: "string" },
      model: { type: "string" },
      "max-tokens": { type: "string" },
      plan: { type: "boolean", default: false }
    }
  })
  if (command === "status" || command === "answer") {
    const id = idOf(positionals[0] ?? "")
    const path = paths(id)
    const stored = await readStored(await inside(root, path.record))
    if (command === "status") {
      const status = await Effect.runPromise(Effect.scoped(
        statusEffect(id).pipe(Effect.provide(
          NodeRuntime.storage(path.filename, root).pipe(Layer.provide(NodeServices.layer))
        ))
      ))
      await report(id, status)
      return
    }
    if (positionals.length !== 2 || !["true", "false"].includes(positionals[1]!)) {
      throw new Error("answer requires a run ID and literal true or false")
    }
    const result = await Effect.runPromise(
      Effect.scoped(
        drive(stored, positionals[1] === "true").pipe(
          Effect.provide(runtime({ root, filename: path.filename, model: stored.model, maxTokens: stored.maxTokens }))
        )
      )
    )
    await report(id, result)
    return
  }
  if (command !== "release" && command !== "release-content") throw new Error(`Unknown command: ${command}`)
  if (positionals.length) throw new Error("Unexpected positional arguments")
  if (values.input && values["input-file"]) throw new Error("Use either --input or --input-file")
  const id = idOf(values.resume ?? values.run ?? `${command}-${randomUUID()}`)
  const path = paths(id)
  let stored: StoredRun
  if (values.resume) {
    if (values.input || values["input-file"] || values.model || values["max-tokens"] || values.run) {
      throw new Error("--resume uses the stored input and settings")
    }
    stored = await readStored(await inside(root, path.record))
    if (stored.kind !== command) throw new Error("Run belongs to a different workflow")
  } else {
    const supplied: unknown = JSON.parse(
      values["input-file"] ? await readFile(resolve(values["input-file"]), "utf8") : values.input ?? "{}"
    )
    const current = JSON.parse(await readFile(join(root, "packages/smithers/package.json"), "utf8")) as {
      version: string
    }
    const maxTokens = Number(values["max-tokens"] ?? "250000")
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("max-tokens must be a positive integer")
    const settings = { schemaVersion: 1 as const, id, model: values.model ?? "openai:gpt-6-sol", maxTokens }
    stored = command === "release"
      ? { ...settings, kind: command, input: releaseInput(supplied, current.version) }
      : { ...settings, kind: command, input: contentInput(supplied, current.version) }
  }
  if (values.plan) {
    const graph = stored.kind === "release"
      ? Graph.build(Release, Schema.decodeUnknownSync(ReleaseInput)(stored.input))
      : Graph.build(ReleaseContent, Schema.decodeUnknownSync(ContentInput)(stored.input))
    process.stdout.write(
      JSON.stringify(
        {
          kind: stored.kind,
          input: stored.input,
          nodes: [...Graph.nodes(graph)].map((node) => ({ kind: node.kind, ast: node.ast }))
        },
        null,
        2
      ) + "\n"
    )
    return
  }
  const host = runtime({ root, filename: path.filename, model: stored.model, maxTokens: stored.maxTokens })
  const previous = await maybeRead(await inside(root, path.record))
  if (previous && !isDeepStrictEqual(Schema.decodeUnknownSync(StoredRun)(JSON.parse(previous)), stored)) {
    throw new Error("Run ID already belongs to different input/settings; use --resume or a new ID")
  }
  await mkdir(await inside(root, path.directory), { recursive: true })
  if (!previous) {
    await atomicWrite(root, path.record, JSON.stringify(Schema.encodeSync(StoredRun)(stored), null, 2) + "\n")
  }
  process.stdout.write(`Run ${id}; state ${path.directory}\n`)
  const result = await Effect.runPromise(Effect.scoped(drive(stored).pipe(Effect.provide(host))))
  await report(id, result)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
