/**
 * Descriptor-generated install commands. No command owns a second HTTP binding.
 *
 * @since 1.0.0
 */

import { Cli, z } from "incur"
import { randomUUID } from "node:crypto"
import { catalogDescriptors } from "../../Catalog.ts"
import { catalogRequest } from "../../CatalogRequest.ts"
import type { Runtime } from "../../cli/ControlBridge.ts"
import * as Presentation from "../../cli/Presentation.ts"
import { Refused, UsageError } from "../../CliError.ts"
import * as Failure from "../Failure.ts"
import { draftFromIssue } from "./IssueDraft.ts"
import { Client, list, object } from "./Client.ts"
import { targetsInstall } from "./Destination.ts"
import { definitions } from "./Definitions.ts"

/**
 * Generated operations with a CLI door and external-agent policy.
 *
 * @private
 * @since 1.0.0
 */
export const catalogCommands = catalogDescriptors.filter((row) =>
  row.cli !== null && (row.agent === "never" || (row.actors.includes("external_agent") &&
    (row.visibility === "core" || row.visibility === "advanced")))
)

// Effect's empty Struct is JSON Schema's non-null value. Zod cannot import
// `not`, so retain that exact predicate instead of refusing no-argument doors.
const payloadSchema = (schema: Record<string, any>): z.ZodType =>
  schema.not?.type === "null" && Object.keys(schema).every((key) => key === "not" || key === "$defs")
    ? z.unknown().refine((value) => value !== null, "Expected a non-null value")
    : z.fromJSONSchema(schema)

const valueSchema = (schema: Record<string, any>): z.ZodType => {
  const decoded = payloadSchema(schema)
  // Nullable objects, arrays and numbers are unions, not top-level types.
  // Preserve literal strings first, then validate parsed JSON with the same schema.
  return z.preprocess((value) => {
    if (typeof value !== "string" || decoded.safeParse(value).success) return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }, decoded)
}

/**
 * Shared descriptor dispatcher for catalog doors and retained backend schemas.
 * @private
 * @since 1.0.0
 */
export const dispatchCatalog = async (
  client: Client,
  row: typeof catalogCommands[number],
  values: Record<string, unknown>
): Promise<unknown> => {
  const fields = (row.payload.schema as { properties?: Record<string, unknown> }).properties ?? {}
  const supplied: Record<string, unknown> = {
    ...values,
    ...(row.name === "todo.answer" && values.todo !== undefined
      ? { n: Number(String(values.todo).replace(/^T/, "")) } : {})
  }
  if (row.agent === "never") {
    throw new Refused({
      fault: "policy",
      code: "never",
      class: "never",
      message: "Only a person can do this in the app"
    })
  }
  if (row.http === null && row.client === undefined) {
    throw new Refused({ fault: "infra", code: "not_available", message: "Not available yet" })
  }
  const input = Object.fromEntries(
    Object.keys(fields).filter((key) => supplied[key] !== undefined).map((key) => [key, supplied[key]])
  )
  const payload = payloadSchema({ ...row.payload.schema, $defs: row.payload.definitions }).parse(
    input
  ) as Record<string, unknown>
  if (row.name === "todo.answer" && typeof payload.answer === "string" && !payload.answer.trim()) {
    throw new UsageError({ message: "An answer is required" })
  }
  const requestId = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : randomUUID()
  const prepared = row.client?.kind === "issue-draft" ? await draftFromIssue(client, payload, client.runtime.signal) : payload
  let request: ReturnType<typeof catalogRequest>
  try {
    request = catalogRequest({ http: row.client?.http ?? row.http }, prepared)
  } catch (error) {
    throw new UsageError({ message: error instanceof Error ? error.message : "Invalid command request" })
  }
  const body = request.body ?? {}
  if (row.name === "todo.answer" && !body.wait) {
    const read = catalogRequest(
      catalogCommands.find((candidate) => candidate.name === "todo")!,
      { n: payload.n }
    )
    const current = object(await client.request(read.method, read.path))
    const questions = list(current.waits).map(object).filter((wait) => wait.kind === "question")
    if (questions.length === 0) {
      throw new Refused({ fault: "user", code: "no_question", message: `T${String(payload.n)} asks nothing` })
    }
    if (questions.length !== 1) {
      throw new Refused({
        fault: "user",
        code: "several_questions",
        message: `T${String(payload.n)} asks several questions; name one with --wait`
      })
    }
    body.wait = questions[0]!.id
  }
  const response = await client.response(
    request.method,
    request.path,
    request.method === "GET" ? undefined : body,
    { headers: request.method === "GET" ? {} : { "Idempotency-Key": requestId } }
  )
  const text = await client.text(response)
  let result: unknown = text.trim() ? JSON.parse(text) : null
  if (row.name === "todo.answer") result = { todo: payload.n, wait: body.wait, ...object(result) }
  const receipt = object(result)
  if (receipt.confirmation !== undefined || receipt.state === "pending") {
    if (
      response.status !== 202 || receipt.state !== "pending" || typeof receipt.confirmation !== "string" ||
      !receipt.confirmation.trim()
    ) {
      throw new Refused({
        fault: "infra",
        code: "backend_protocol",
        message: "Invalid confirmation response"
      })
    }
    let person = "you"
    const encodedPerson = response.headers.get("Smithers-Confirmation-Person")
    if (encodedPerson) {
      try {
        person = Presentation.clean(decodeURIComponent(encodedPerson)).replace(/[\r\n]+/g, " ").trim() ||
          person
      } catch { /* Old or malformed presentation metadata never changes authority. */ }
    }
    result = { ...receipt, message: `Waiting for ${person} to confirm` }
    client.runtime.exit?.(3)
  }
  return client.redact(result)
}

/**
 * Mount catalog operations through the shared request encoder and CLI transport.
 *
 * @private
 * @since 1.0.0
 */
export const mountCatalog = (cli: Cli.Cli<any, any, any, any>, runtime: Runtime) => {
  const tree = Cli.toCommands.get(cli as never)!
  for (const row of catalogCommands) {
    const words = row.cli!, leaf = words.at(-1)!
    let parent = tree
    for (const word of words.slice(0, -1)) {
      let entry = parent.get(word)
      if (!entry || !("_group" in entry)) {
        const group = Cli.create(word, { description: row.group })
        const mounted = Cli.toCommands.get(Cli.create("root").command(group))!.get(word)!
        entry = entry && "run" in entry ? { ...mounted, root: entry } : mounted
        parent.set(word, entry)
      }
      if (!("_group" in entry)) throw new Error(`Cannot mount catalog group ${word}`)
      parent = entry.commands
    }
    const existing = parent.get(leaf)
    // Compose one door with the local parser and explicit destination dispatch.
    // A group may still need a catalog root without losing its local children.
    const local = existing && "_group" in existing ? existing.root : existing
    const schema = row.payload.schema as { properties?: Record<string, any>; required?: Array<string> }
    const fields = schema.properties ?? {}, required = new Set(schema.required ?? [])
    const positional = ["n", "id", "number", "name", "path", "workflow"].find((key) => required.has(key))
    const positionalKeys = new Set([
      positional,
      ...(positional === "n" ? ["answer", "text", "direction"].filter((key) => required.has(key)) : [])
    ])
    const args: Record<string, z.ZodType> = {}, options: Record<string, z.ZodType> = {}
    for (const [key, field] of Object.entries(fields)) {
      let value = (key === "n" && key === positional) || key === "before"
        ? z.string().regex(/^T[1-9]\d*$/, "Expected Tn").transform((value) => Number(value.slice(1))).meta({
          type: "string",
          pattern: "^T[1-9]\\d*$"
        })
        : valueSchema({ ...field, $defs: row.payload.definitions })
      if (!required.has(key)) value = value.optional()
      if (positionalKeys.has(key)) args[key] = value
      else options[key] = value
    }
    const localArgs = local && "run" in local && local.args ? Object.keys(local.args.shape) : []
    const catalogArgs = Object.keys(args)
    const command = Cli.create("root").command(leaf, {
      description: `${row.summary}${row.agent === "confirm" ? "; waits for the person's confirmation" : ""}`,
      mcp: row.agent === "never" ? false : { annotations: { readOnlyHint: row.http?.method === "GET" } },
      args: row.name === "todo.answer" ? definitions["todo answer"].args : local && "run" in local ? local.args ?? z.object(args) : z.object(args),
      options: row.name === "todo.answer" ? definitions["todo answer"].options : local && "run" in local && local.options ? local.options.partial().extend(options) : z.object(options),
      run: (context: any) => {
        if (local && "run" in local && !targetsInstall(context, runtime)) {
          return local.run({ ...context, options: local.options?.parse(context.options) ?? context.options })
        }
        return Presentation.guard(context, async () => {
          const client = new Client(runtime)
          try {
            const mapped = { ...context.args }
            if (local && "run" in local) {
              catalogArgs.forEach((key, index) => { if (localArgs[index]) mapped[key] = context.args[localArgs[index]!] })
            }
            const parsed = local && "run" in local && row.http && row.name !== "todo.answer" ? z.object(args).parse(mapped) : mapped
            const value = await dispatchCatalog(client, row, { ...parsed, ...context.options })
            return ["md", "yaml", "toon"].includes(context.format) ? Failure.terminalSafeValue(value) : value
          } catch (error) {
            throw client.failure(error)
          } finally {
            client.flushOutput()
          }
        }, {
          next: [],
          render: (value) => {
            const receipt = object(Failure.terminalSafeValue(value))
            return {
              human: receipt.confirmation !== undefined && receipt.state === "pending"
                ? `${String(receipt.message)}\n${String(receipt.confirmation)} pending` :
                JSON.stringify(Failure.terminalSafeValue(value))
            }
          }
        })
      }
    })
    const mounted = Cli.toCommands.get(command)!.get(leaf)!
    parent.set(leaf, existing && "_group" in existing && "run" in mounted ? { ...existing, description: row.name === "stack" ? row.summary : existing.description, root: mounted } : mounted)
  }
}
