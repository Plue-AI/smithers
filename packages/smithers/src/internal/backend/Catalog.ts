/** Descriptor-generated install commands. No command owns a second HTTP binding. */
import { randomUUID } from "node:crypto"
import { Cli, z } from "incur"
import catalog from "./catalog.mvp.json" with { type: "json" }
import type { Runtime } from "../../cli/ControlBridge.ts"
import * as Presentation from "../../cli/Presentation.ts"
import { Refused, UsageError } from "../../CliError.ts"
import { Client, object, list } from "./Client.ts"

interface CatalogDescriptor {
  name: string; cli: string[] | null; actors: string[]; visibility: string; group: string; agent: string; summary: string;
  payload: { schema: Record<string, any>; definitions?: Record<string, any> };
  http: { method: string; path: string; body?: Record<string, string>; defaults?: Record<string, unknown>; query?: Record<string, string> } | null
}
export const catalogCommands = (catalog.operations as CatalogDescriptor[]).filter(row => row.cli !== null && (row.agent === "never" || (row.actors.includes("external_agent") &&
  (row.visibility === "core" || row.visibility === "advanced"))))

const valueSchema = (schema: Record<string, any>): z.ZodType => {
  const decoded = z.fromJSONSchema(schema)
  if (["object", "array"].includes(schema.type)) return z.preprocess(value => {
    if (typeof value !== "string") return value
    try { return JSON.parse(value) } catch { return value }
  }, decoded)
  return decoded
}

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
    const schema = row.payload.schema as { properties?: Record<string, any>; required?: string[] }
    const fields = schema.properties ?? {}, required = new Set(schema.required ?? [])
    const positional = ["n", "id", "number", "name", "path", "workflow"].find(key => required.has(key))
    const positionalKeys = new Set([positional, ...(positional === "n" ? ["answer", "text", "direction"].filter(key => required.has(key)) : [])])
    const args: Record<string, z.ZodType> = {}, options: Record<string, z.ZodType> = {}
    for (const [key, field] of Object.entries(fields)) {
      let value = key === "n" && key === positional
        ? z.string().regex(/^T[1-9]\d*$/, "Expected Tn").transform(value => Number(value.slice(1)))
        : valueSchema({ ...field, $defs: row.payload.definitions })
      if (!required.has(key)) value = value.optional()
      if (positionalKeys.has(key)) args[key] = value
      else options[key] = value
    }
    const command = Cli.create("root").command(leaf, {
      description: `${row.summary}${row.agent === "confirm" ? "; waits for the person's confirmation" : ""}`,
      args: z.object(args), options: z.object(options),
      run: (context: any) => Presentation.guard(context, async () => {
        if (row.agent === "never") throw new Refused({ fault: "policy", code: "never", class: "never", message: "Only a person can do this in the app" })
        if (row.http === null) throw new Refused({ fault: "infra", code: "not_available", message: "Not available yet" })
        const supplied = { ...context.args, ...context.options }
        const requestId = randomUUID()
        const input = Object.fromEntries(Object.keys(fields).filter(key => supplied[key] !== undefined).map(key => [key, supplied[key]]))
        const payload = z.fromJSONSchema({ ...row.payload.schema, $defs: row.payload.definitions } as any).parse(input) as Record<string, unknown>
        const binding = row.http as { method: string; path: string; body?: Record<string, string>; defaults?: Record<string, unknown>; query?: Record<string, string> }
        const body: Record<string, unknown> = binding.body
          ? Object.fromEntries(Object.entries(binding.body).filter(([, source]) => payload[source] !== undefined).map(([field, source]) => [field, payload[source]]))
          : { ...payload }
        Object.assign(body, binding.defaults)
        let path = row.http.path.replace(/\{([^}]+)\}/g, (_, field: string) => {
          const value = payload[field]
          if (value === undefined) throw new UsageError({ message: `Missing ${field}` })
          delete body[field]
          return encodeURIComponent(String(value))
        })
        if (binding.method === "GET") {
          const query = new URLSearchParams()
          for (const [field, source] of Object.entries(binding.query ?? Object.fromEntries(Object.keys(body).map(key => [key, key])))) {
            if (payload[source] !== undefined) query.set(field, String(payload[source]))
          }
          if (query.size) path += `?${query}`
        }
        const client = new Client(runtime)
        try {
          if (row.name === "todo.answer" && !body.wait) {
            const read = catalogCommands.find(candidate => candidate.name === "todo")!.http!
            const current = object(await client.request(read.method, read.path.replace("{n}", String(payload.n))))
            const questions = list(current.waits).map(object).filter(wait => wait.kind === "question")
            if (questions.length === 0) throw new Refused({ fault: "user", code: "no_question", message: `T${String(payload.n)} asks nothing` })
            if (questions.length !== 1) throw new Refused({ fault: "user", code: "several_questions", message: `T${String(payload.n)} asks several questions; name one with --wait` })
            body.wait = questions[0]!.id
          }
          let result = await client.request(row.http.method, path, row.http.method === "GET" ? undefined : body, { headers: row.http.method === "GET" ? {} : { "Idempotency-Key": requestId } })
          if (row.name === "todo.answer") result = { todo: payload.n, wait: body.wait, ...object(result) }
          const receipt = object(result)
          if (receipt.confirmation !== undefined && receipt.state === "pending") runtime.exit?.(3)
          return client.redact(result)
        } catch (error) { throw client.failure(error) } finally { client.flushOutput() }
      }, { next: [], render: value => {
        const receipt = object(value)
        return { human: receipt.confirmation !== undefined && receipt.state === "pending"
          ? `Waiting for you to confirm\n${String(receipt.confirmation)} pending` : JSON.stringify(value) }
      } })
    })
    const mounted = Cli.toCommands.get(command)!.get(leaf)!
    const existing = parent.get(leaf)
    parent.set(leaf, existing && "_group" in existing && "run" in mounted ? { ...existing, root: mounted } : mounted)
  }
}
