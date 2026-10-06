/**
 * Descriptor-generated install commands. No command owns a second HTTP binding.
 *
 * @since 1.0.0
 */

import { Cli, z } from "incur"
import { randomUUID } from "node:crypto"
import { type CatalogHttpBinding, catalogRequest } from "../../CatalogRequest.ts"
import type { Runtime } from "../../cli/ControlBridge.ts"
import * as Presentation from "../../cli/Presentation.ts"
import { Refused, UsageError } from "../../CliError.ts"
import catalog from "./catalog.mvp.json" with { type: "json" }
import { Client, list, object } from "./Client.ts"

interface CatalogDescriptor {
  name: string
  cli: Array<string> | null
  actors: Array<string>
  visibility: string
  group: string
  agent: string
  summary: string
  payload: { schema: Record<string, any>; definitions?: Record<string, any> }
  http: CatalogHttpBinding | null
}
/**
 * Generated operations with a CLI door and external-agent policy.
 *
 * @private
 * @since 1.0.0
 */
export const catalogCommands = (catalog.operations as Array<CatalogDescriptor>).filter((row) =>
  row.cli !== null && (row.agent === "never" || (row.actors.includes("external_agent") &&
    (row.visibility === "core" || row.visibility === "advanced")))
)

const valueSchema = (schema: Record<string, any>): z.ZodType => {
  const decoded = z.fromJSONSchema(schema)
  if (["object", "array"].includes(schema.type)) {
    return z.preprocess((value) => {
      if (typeof value !== "string") return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }, decoded)
  }
  return decoded
}

/**
 * Mount catalog operations through the shared request encoder and CLI transport.
 *
 * @private
 * @since 1.0.0
 */
export const mountCatalog = (cli: Cli.Cli<any, any, any, any>, runtime: Runtime) => {
  const tree = Cli.toCommands.get(cli as never)!
  // Appendix B.6's old PR-stack tool has no MVP door; stack now means the install's stack.
  tree.delete("stack")
  for (const row of catalogCommands) {
    const words = row.cli!, leaf = words.at(-1)!
    let parent = tree
    for (const word of words.slice(0, -1)) {
      let entry = parent.get(word)
      if (!entry || !("_group" in entry)) {
        const group = Cli.create(word, { description: row.group })
        entry = Cli.toCommands.get(Cli.create("root").command(group))!.get(word)!
        parent.set(word, entry)
      }
      if (!("_group" in entry)) throw new Error(`Cannot mount catalog group ${word}`)
      parent = entry.commands
    }
    const schema = row.payload.schema as { properties?: Record<string, any>; required?: Array<string> }
    const fields = schema.properties ?? {}, required = new Set(schema.required ?? [])
    const positional = ["n", "id", "number", "name", "path", "workflow"].find((key) => required.has(key))
    const positionalKeys = new Set([
      positional,
      ...(positional === "n" ? ["answer", "text", "direction"].filter((key) => required.has(key)) : [])
    ])
    const args: Record<string, z.ZodType> = {}, options: Record<string, z.ZodType> = {}
    for (const [key, field] of Object.entries(fields)) {
      let value = key === "n" && key === positional
        ? z.string().regex(/^T[1-9]\d*$/, "Expected Tn").transform((value) => Number(value.slice(1)))
        : valueSchema({ ...field, $defs: row.payload.definitions })
      if (!required.has(key)) value = value.optional()
      if (positionalKeys.has(key)) args[key] = value
      else options[key] = value
    }
    const command = Cli.create("root").command(leaf, {
      description: `${row.summary}${row.agent === "confirm" ? "; waits for the person's confirmation" : ""}`,
      args: z.object(args),
      options: z.object(options),
      run: (context: any) =>
        Presentation.guard(context, async () => {
          if (row.agent === "never") {
            throw new Refused({
              fault: "policy",
              code: "never",
              class: "never",
              message: "Only a person can do this in the app"
            })
          }
          if (row.http === null) {
            throw new Refused({ fault: "infra", code: "not_available", message: "Not available yet" })
          }
          const supplied = { ...context.args, ...context.options }
          const requestId = randomUUID()
          const input = Object.fromEntries(
            Object.keys(fields).filter((key) => supplied[key] !== undefined).map((key) => [key, supplied[key]])
          )
          const payload = z.fromJSONSchema({ ...row.payload.schema, $defs: row.payload.definitions } as any).parse(
            input
          ) as Record<string, unknown>
          let request: ReturnType<typeof catalogRequest>
          try {
            request = catalogRequest(row, payload)
          } catch (error) {
            throw new UsageError({ message: error instanceof Error ? error.message : "Invalid command request" })
          }
          const body = request.body ?? {}
          const client = new Client(runtime)
          try {
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
            let result = await client.request(
              request.method,
              request.path,
              request.method === "GET" ? undefined : body,
              { headers: request.method === "GET" ? {} : { "Idempotency-Key": requestId } }
            )
            if (row.name === "todo.answer") result = { todo: payload.n, wait: body.wait, ...object(result) }
            const receipt = object(result)
            if (receipt.confirmation !== undefined && receipt.state === "pending") runtime.exit?.(3)
            return client.redact(result)
          } catch (error) {
            throw client.failure(error)
          } finally {
            client.flushOutput()
          }
        }, {
          next: [],
          render: (value) => {
            const receipt = object(value)
            return {
              human: receipt.confirmation !== undefined && receipt.state === "pending"
                ? `Waiting for you to confirm\n${String(receipt.confirmation)} pending` :
                JSON.stringify(value)
            }
          }
        })
    })
    const mounted = Cli.toCommands.get(command)!.get(leaf)!
    const existing = parent.get(leaf)
    parent.set(leaf, existing && "_group" in existing && "run" in mounted ? { ...existing, root: mounted } : mounted)
  }
}
