/**
 * Persistent memory administration over the same store used by agent runs.
 *
 * @since 1.0.0
 */

import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Namespace from "@smthrs/memory/Namespace"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallFts from "@smthrs/memory/RecallFts"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import { Effect, Layer, Schema } from "effect"
import { Cli, z } from "incur"
import { randomUUID } from "node:crypto"
import * as Presentation from "../cli/Presentation.ts"
import * as CliError from "../CliError.ts"
import { databaseLayer, localFields, type LocalOptions, localRoot } from "./Store.ts"

/** An operator request this command refuses; the operator fixes the input or the host setup. */
const refused = (message: string, fault: CliError.Fault = "user"): CliError.Refused =>
  new CliError.Refused({ fault, code: "operator_failed", message })

// Every operator command reports failures as operator_failed.
const execute = <A>(context: Presentation.Failing, body: () => Promise<A>) =>
  Presentation.guard(context, body, {
    code: "operator_failed",
    next: Presentation.runs({
      otherwise: [{ command: "memory recall --help", description: "Recall relevant stored context" }]
    })
  })

const namespaceFields = {
  namespace: z.string().default("user:cli").describe(
    "Memory namespace: user:cli, flow:<id>, agent:<id>, or global:<id>"
  ),
  id: z.string().optional().describe("Namespace identifier when --namespace is a bare lifetime such as user")
}
const options = z.object({ ...localFields, ...namespaceFields })
const limited = options.extend({ limit: z.number().int().positive().max(10000).default(100) })
const namespace = (input: { namespace: string; id?: string | undefined }): Namespace.Namespace => {
  const separator = input.namespace.indexOf(":")
  if (separator >= 0 && input.id !== undefined) {
    throw refused("Use either --namespace kind:id or --namespace kind --id id")
  }
  const kind = separator < 0 ? input.namespace : input.namespace.slice(0, separator)
  const id = separator < 0 ? input.id ?? "cli" : input.namespace.slice(separator + 1)
  if (/[\p{Cc}]/u.test(id)) throw refused("Memory namespace IDs cannot contain control characters")
  try {
    return Schema.decodeUnknownSync(Namespace.Namespace, { reportInput: false })({ kind, id })
  } catch {
    throw refused("Use --namespace user:<id>, flow:<id>, agent:<id>, or global:<id>")
  }
}
/** Validates user-supplied memory tags at the CLI boundary. */
const tags = (input: ReadonlyArray<string>) => {
  try {
    return Schema.decodeUnknownSync(Namespace.Tags)(input)
  } catch {
    throw refused(
      `Memory tags must be unique, at most ${Namespace.MAX_TAGS}, and start with branch:, stream:, source:, or scope:`
    )
  }
}
const noteStatus = z.enum(["pending", "accepted", "rejected"])

/**
 * Runs an operation against the authoritative local memory store.
 * @category constructors
 * @since 1.0.0
 */
export const withMemory = <A, E>(
  options: LocalOptions & { readonly namespace?: string | undefined; readonly id?: string | undefined },
  effect: Effect.Effect<A, E, MemoryStore.MemoryStore>
): Promise<A> => {
  if (options.namespace !== undefined) namespace({ ...options, namespace: options.namespace })
  const layer = MemoryStore.layer.pipe(Layer.provide(databaseLayer(localRoot(options))))
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

/**
 * Builds the fact, note, thread, message, and recall commands.
 * @category constructors
 * @since 1.0.0
 */
export const createMemoryCli = () => {
  const notes = Cli.create("notes", { description: "Append-only notes, status gates, and supersession" })
    .command("list", {
      description: "List notes in a namespace",
      mcp: { annotations: { readOnlyHint: true } },
      options: limited.extend({
        status: z.enum(["pending", "accepted", "rejected", "any"]).default("any"),
        includeSuperseded: z.boolean().default(false)
      }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return yield* store.listNotes({
                namespace: namespace(context.options),
                limit: context.options.limit,
                status: context.options.status,
                includeSuperseded: context.options.includeSuperseded
              })
            })
          ))
    })
    .command("get", {
      description: "Read one note by its globally unique ID",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ note: z.string() }),
      options: z.object(localFields),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              const note = yield* store.getNote({ id: context.args.note })
              if (note === undefined) return yield* Effect.fail(refused(`Unknown note ${context.args.note}`))
              return note
            })
          ))
    })
    .command("add", {
      description: "Append a note, optionally superseding older notes",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ text: z.string().min(1) }),
      options: options.extend({
        noteId: z.string().optional(),
        status: noteStatus.default("accepted"),
        tag: z.array(z.string()).default([]),
        supersedes: z.array(z.string()).default([])
      }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return yield* store.putNote({
                namespace: namespace(context.options),
                id: context.options.noteId ?? randomUUID(),
                text: context.args.text,
                status: context.options.status,
                tags: tags(context.options.tag),
                supersedes: context.options.supersedes,
                provenance: {}
              })
            })
          ))
    })
    .command("status", {
      description: "Accept, reject, or return a note to pending review",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ note: z.string(), status: noteStatus }),
      options: z.object(localFields),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              yield* store.setNoteStatus({ id: context.args.note, status: context.args.status })
              return { id: context.args.note, status: context.args.status }
            })
          ))
    })
    .command("supersede", {
      description: "Mark an older note superseded by an existing note",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ note: z.string(), replacement: z.string() }),
      options: z.object(localFields),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              yield* store.supersede({ targetId: context.args.note, supersederId: context.args.replacement })
              return { superseded: context.args.note, replacement: context.args.replacement }
            })
          ))
    })

  const threads = Cli.create("threads", { description: "Inspect and maintain durable conversation history" })
    .command("list", {
      description: "List threads in a namespace",
      mcp: { annotations: { readOnlyHint: true } },
      options,
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return yield* store.listThreads({ namespace: namespace(context.options) })
            })
          ))
    })
    .command("create", {
      description: "Create a durable history thread",
      mcp: { annotations: { readOnlyHint: false } },
      options: options.extend({ title: z.string().optional(), threadId: z.string().optional() }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return yield* store.createThread({
                namespace: namespace(context.options),
                id: context.options.threadId,
                title: context.options.title
              })
            })
          ))
    })
    .command("show", {
      description: "Show a thread and its ordered messages",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ thread: z.string() }),
      options: limited,
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              const thread = yield* store.getThread({ threadId: context.args.thread })
              if (thread === undefined) return yield* Effect.fail(refused(`Unknown thread ${context.args.thread}`))
              return {
                thread,
                messages: yield* store.listMessages({ threadId: context.args.thread, limit: context.options.limit })
              }
            })
          ))
    })
    .command("rm", {
      description: "Delete one thread and its messages",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ thread: z.string() }),
      options: z.object(localFields),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return {
                threadId: context.args.thread,
                deleted: yield* store.deleteThread({ threadId: context.args.thread })
              }
            })
          ))
    })

  const messages = Cli.create("messages", { description: "Read and append thread messages" })
    .command("list", {
      description: "Read ordered messages with an optional exclusive cursor",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ thread: z.string() }),
      options: z.object({
        ...localFields,
        limit: z.number().int().positive().max(10000).default(100),
        afterId: z.string().optional(),
        afterAt: z.number().int().nonnegative().optional()
      }),
      run: (context) =>
        execute(context, () => {
          if ((context.options.afterId === undefined) !== (context.options.afterAt === undefined)) {
            throw refused("--after-id and --after-at must be supplied together")
          }
          return withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return yield* store.listMessages({
                threadId: context.args.thread,
                limit: context.options.limit,
                cursor: context.options.afterId === undefined
                  ? undefined
                  : { id: context.options.afterId, at: context.options.afterAt! }
              })
            })
          )
        })
    })
    .command("add", {
      description: "Append a message idempotently using its message ID",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ thread: z.string(), text: z.string() }),
      options: z.object({
        ...localFields,
        role: z.enum(["user", "assistant", "system", "tool"]).default("user"),
        messageId: z.string().optional(),
        at: z.number().int().nonnegative().optional()
      }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              const message = {
                threadId: context.args.thread,
                text: context.args.text,
                role: context.options.role,
                id: context.options.messageId ?? randomUUID(),
                at: context.options.at ?? Date.now()
              }
              yield* store.appendMessage(message)
              return message
            })
          ))
    })

  return Cli.create("memory", { description: "Durable facts, notes, recall, and conversation history" })
    .command("list", {
      description: "List facts in a namespace",
      mcp: { annotations: { readOnlyHint: true } },
      options: limited.extend({ prefix: z.string().optional() }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return yield* store.listFacts({
                namespace: namespace(context.options),
                prefix: context.options.prefix,
                limit: context.options.limit
              })
            })
          ))
    })
    .command("get", {
      description: "Read one fact",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ key: z.string() }),
      options,
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              const fact = yield* store.getFact({ namespace: namespace(context.options), key: context.args.key })
              if (fact === undefined) return yield* Effect.fail(refused(`Unknown fact ${context.args.key}`))
              return fact
            })
          ))
    })
    .command("set", {
      description: "Write JSON when valid, otherwise a string; --value-json requires valid JSON",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ key: z.string(), value: z.string() }),
      options: options.extend({
        valueJson: z.boolean().default(false),
        ttlMs: z.number().int().positive().optional(),
        tag: z.array(z.string()).default([])
      }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              let value: unknown = context.args.value
              try {
                value = JSON.parse(context.args.value)
              } catch {
                if (context.options.valueJson) {
                  return yield* Effect.fail(refused("The fact value is not valid JSON"))
                }
              }
              yield* store.putFact({
                namespace: namespace(context.options),
                key: context.args.key,
                value,
                tags: tags(context.options.tag),
                ttlMs: context.options.ttlMs,
                provenance: {}
              })
              return { key: context.args.key, namespace: namespace(context.options), stored: true }
            })
          ))
    })
    .command("rm", {
      description: "Delete one fact",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ key: z.string() }),
      options,
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              return {
                key: context.args.key,
                deleted: yield* store.deleteFact({ namespace: namespace(context.options), key: context.args.key })
              }
            })
          ))
    })
    .command("recall", {
      description: "Search authoritative facts and accepted notes using keyword or SQLite FTS recall",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ query: z.string().min(1) }),
      options: options.extend({
        method: z.enum(["keyword", "fts"]).default("keyword"),
        bank: z.array(z.string()).default([]),
        maxTokens: z.number().int().positive().max(65536).default(2048)
      }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const input = yield* Schema.decodeUnknownEffect(Recall.Input)({
                banks: context.options.bank.length > 0
                  ? context.options.bank
                  : [Recall.bankForNamespace(namespace(context.options))],
                query: context.args.query,
                maxTokens: context.options.maxTokens
              })
              if (context.options.method === "fts") {
                const store = yield* MemoryStore.MemoryStore
                for (const bank of input.banks) yield* store.enableFts(Recall.namespaceForBank(bank).kind)
              }
              return yield* (context.options.method === "fts" ? RecallFts.recall(input) : RecallKeyword.recall(input))
            })
          ))
    })
    .command("compact", {
      description: "Replace selected thread messages with a supplied summary atomically",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ thread: z.string() }),
      options: z.object({
        ...localFields,
        summary: z.string().min(1),
        before: z.number().int().nonnegative(),
        keep: z.number().int().nonnegative().default(10),
        dryRun: z.boolean().default(false)
      }),
      run: (context) =>
        execute(context, () =>
          withMemory(
            context.options,
            Effect.gen(function*() {
              const store = yield* MemoryStore.MemoryStore
              if ((yield* store.getThread({ threadId: context.args.thread })) === undefined) {
                return yield* Effect.fail(refused(`Unknown thread ${context.args.thread}`))
              }
              const messages = yield* store.listMessages({ threadId: context.args.thread })
              const candidates = messages.slice(0, Math.max(0, messages.length - context.options.keep)).filter((
                message
              ) => message.at < context.options.before)
              const ids = candidates.map((message) => message.id)
              if (context.options.dryRun || ids.length === 0) {
                return {
                  threadId: context.args.thread,
                  dryRun: context.options.dryRun,
                  eligible: ids.length,
                  removed: 0
                }
              }
              const summary = {
                threadId: context.args.thread,
                id: randomUUID(),
                role: "system",
                text: context.options.summary,
                at: candidates[candidates.length - 1]!.at
              }
              const removed = yield* store.compactMessages({
                threadId: context.args.thread,
                summary,
                sourceMessages: candidates
              })
              return { threadId: context.args.thread, summaryId: summary.id, removed }
            })
          ))
    })
    .command(notes).command(threads).command(messages)
}
