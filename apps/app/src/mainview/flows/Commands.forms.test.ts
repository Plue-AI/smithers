/*
 * THE FORM LAW at the door (apps/app/AGENTS.md; docs/workbench-lanes/flow-forms.md):
 * a flow invoked without its required input — by the agent or by a typed
 * slash — renders its form card, prefilled with what the line gave, and
 * answers "rendered a form for <fields>"; never a usage sentence. A button
 * always carries its args and never meets the form. Submit re-enters the run
 * path as whoever asked, so an agent's ask on a consequential flow still
 * confirms, and the other doors (W0 unavailable, user-only) stay intact.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, spyOn, test } from "bun:test"
import { AGENT_ROLES, AgentRoleSchema } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness } from "@smthrs/rpc/LocalApp"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import type { Card } from "../state/AppState"
import { Option, Schema } from "effect"
import { createCommandRegistry } from "./Commands"
import type { CommandActions } from "./Flows"
import { assembleArgs, draftFrom, formFieldsFor, missingFields, submissionPayload } from "@smthrs/ui/flow-form"
import type { FormField } from "@smthrs/ui/flow-form"
import { nameOf } from "./registry"
import { payloadFor } from "./SlashPayload"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const EVERYTHING: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const harness = (overrides: Partial<Harness> & Pick<Harness, "id" | "status">): Harness => ({
  displayName: overrides.id,
  binary: overrides.status === "unavailable" ? null : `/usr/local/bin/${overrides.id}`,
  version: "1.0.0",
  account: null,
  launch: { argv: [overrides.id] },
  ...overrides
})

const HARNESSES: ReadonlyArray<Harness> = [
  harness({ id: "claude", displayName: "Claude Code", status: "signed-in", account: { email: "will@example.com" }, models: { suggestions: ["claude-fable-5"], listable: false } }),
  harness({ id: "codex", displayName: "Codex", status: "api-key", account: { label: "OPENAI_API_KEY" }, models: { suggestions: ["gpt-5.6-sol", "gpt-5.6-terra"], listable: false } }),
  harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "binary-only", models: { suggestions: ["kimi-for-coding/k3"], listable: true } }),
  harness({ id: "crush", displayName: "Crush", status: "api-key", account: { label: "OPENAI_API_KEY" } }),
  harness({ id: "pi", displayName: "Pi", status: "unavailable" })
]

const settle = async (ticks = 8): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const agents: Array<AgentRole> = [...AGENT_ROLES]
  const puts: Array<{ id: string; body: Record<string, unknown> }> = []
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: EVERYTHING,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      const method = init?.method ?? "GET"
      if (path === "/api/harnesses") return json(200, { harnesses: HARNESSES })
      if (path === "/api/agents" && method === "GET") return json(200, { agents })
      const put = /^\/api\/agents\/([^/]+)$/.exec(path)
      if (put !== null && method === "PUT") {
        const id = put[1]!
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        puts.push({ id, body })
        const row = AgentRoleSchema.parse({ id, ...body, delegates: false, builtin: false, createdAt: 100, updatedAt: 101 })
        agents.push(row)
        return json(201, { agent: row })
      }
      const models = /^\/api\/harnesses\/([^/]+)\/models$/.exec(path)
      if (models !== null) {
        if (models[1] === "codex") return json(200, { harnessId: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], source: "list" })
        return json(200, { harnessId: models[1], models: [], source: "suggestions", reason: "no list command" })
      }
      return json(404, { error: { code: "absent", message: `no stub for ${method} ${path}` } })
    }
  })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: true, scopesPlain: null })
  store.dispatch({ type: "card.upsert", actor: "system", card: { id: "card-1", kind: "status", title: "Status", status: "active", createdAt: 1, ordinal: 0, payload: { progress: 0.5 } } })
  await settle()
  return { store, controller, puts }
}

/** The production agent door (turns.ts continueToolLeg): one tool call, run as actor smithers. */
const execute = (controller: Awaited<ReturnType<typeof boot>>["controller"], name: string, args?: string) =>
  controller.commands.executeForAgent({
    name: "commands",
    arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
  })

const formOf = (store: AppStore, flow: string): Extract<Card, { kind: "flow-form" }> | undefined => {
  const card = store.collections.cards.get(`form-${flow}`)
  return card?.kind === "flow-form" ? card : undefined
}

const messages = (store: AppStore) => [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal)

describe("THE FORM LAW — the agent door", () => {

  test("the user-only refusal and the W0 door are untouched: a user-only flow without args is refused by name, never formed", async () => {
    const { store, controller } = await boot()
    const result = await execute(controller, "tab.select")
    expect(result).toStartWith("failed: /tab.select is user-only")
    expect(formOf(store, "tab.select")).toBeUndefined()
  })
})

describe("THE FORM LAW — the slash door and the button door", () => {
  test("partial JSON slash inputs open usable forms instead of failing the command", async () => {
    const { store, controller } = await boot()
    try {
      for (const flow of ["issue.add-flow", "files.open-diff"] as const) {
        for (const args of ["7", "0", '"hello world"', "500000", "null", "[]", "{invalid", "{}"]) {
          const outcome = await controller.commands.run(flow, args)
          expect(outcome.status).toBe("form")
          expect(formOf(store, flow)?.payload.fields.length).toBeGreaterThan(0)
        }
      }
      const issue = await controller.commands.run("issue.add-flow", '{"number":7}')
      expect(issue.status).toBe("form")
      expect(formOf(store, "issue.add-flow")?.payload.draft).toMatchObject({ number: 7 })
      expect(payloadFor("issue.add-flow", '{"number":7,"description":"add a flow"}')).toEqual({ payload: { number: 7, description: "add a flow" } })
      expect(payloadFor("files.open-diff", '{"cardId":"card-1","path":"src/main.ts"}')).toEqual({ payload: { cardId: "card-1", path: "src/main.ts" } })
      const diff = await controller.commands.run("files.open-diff", '{"cardId":"card-1"}')
      expect(diff.status).toBe("form")
      expect(formOf(store, "files.open-diff")?.payload.draft).toMatchObject({ cardId: "card-1" })
    } finally {
      await controller.dispose()
    }
  })

  /*
   * Walk W1 (W1-d-doors.json `pauseFormFields`): the person typed
   * `/triggers.pause canary-w1-not-registered` and read back
   * `Repo = "canary-w1-not-registered"` with `Slug` empty. The name they typed
   * is the schedule's, and the form has to ask for the repository — not for
   * the thing they already said.
   */
  test("a positional argument prefills the field the door names, not the optional repository in front of it", async () => {
    const { store, controller } = await boot()
    const outcome = await controller.commands.run("triggers.pause", "canary-w1-not-registered")
    expect(outcome.status).toBe("form")
    const card = formOf(store, "triggers.pause")
    expect(card?.payload.fields.map((field) => field.label)).toEqual(["Repo", "Slug"])
    expect(card?.payload.draft).toEqual({ slug: "canary-w1-not-registered" })
    /*
     * R102 B1: the token now fills the required slot, so nothing is missing —
     * and a card whose optional slot the read passed over must NOT answer with
     * the grammar's reason, which is addressed to a line the form has just
     * read (controller/forms.ts).
     */
    expect(card?.payload.error).toBeUndefined()
    await controller.dispose()
  })

  test("typed /triggers.pause nightly will/flows never quotes a button refusal", async () => {
    const { store, controller } = await boot()
    expect((await controller.commands.run("triggers.pause", "nightly will/flows")).status).toBe("form")
    const card = formOf(store, "triggers.pause")
    expect(card?.payload.error).toBeUndefined()
    expect(JSON.stringify(card?.payload)).not.toContain("takes the values its button carries")
    await controller.dispose()
  })

  /*
   * R102c B1c, on the door the same skip rule moved: three words reach Flow,
   * Name and Schedule, and the card does not then quote the grammar's usage
   * line at the person about a line the form just read. At `main@origin` the
   * same line leaves Schedule empty and the card says nothing, so this is the
   * branch keeping its own sentence count, not adding one.
   */
  test("a line whose tokens the read placed over a skipped slot earns no usage sentence", async () => {
    const { store, controller } = await boot()
    expect((await controller.commands.run("model.save", "one two three four")).status).toBe("form")
    const card = formOf(store, "model.save")
    expect(card?.payload.draft).toMatchObject({ name: "one", protocol: "two", modelId: "three", credential: "four" })
    expect(card?.payload.error).toBeUndefined()
    /*
     * The register form is one input (D-18, the Run it every night app): every
     * positional word reaches the flow, nothing is left to ask, and the line
     * keeps the grammar's own sentence about itself (R102d B1d), as any line
     * that fills its whole card does.
     */
    expect((await controller.commands.run("triggers.register", "one two three")).status).toBe("form")
    expect(formOf(store, "triggers.register")?.payload.draft).toEqual({ flow: "one two three" })
    expect(formOf(store, "triggers.register")?.payload.error).toContain("triggers.register takes")
    await controller.dispose()
  })

  /*
   * The subtraction above is exactly that one: a line no slot was skipped for
   * keeps the sentence `main@origin` puts on the card, including every
   * complaint about a value the card is holding (R102d B1d). `/flow.run 7 8 9`
   * is one character from the `{invalid` case and is the same field.
   */
  test("a card still states what its own values are wrong about", async () => {
    const { store, controller } = await boot()
    expect((await controller.commands.run("flow.run", "7 8 9")).status).toBe("form")
    expect(formOf(store, "flow.run")?.payload.draft).toEqual({ name: "7", repo: "8", input: "9" })
    expect(formOf(store, "flow.run")?.payload.error).toBe("Flow input must be a JSON object.")
    expect((await controller.commands.run("issue.implement", "0")).status).toBe("form")
    expect(formOf(store, "issue.implement")?.payload.error).toBe("An issue number is required")
    expect((await controller.commands.run("issues.list", "one")).status).toBe("form")
    expect(formOf(store, "issues.list")?.payload.error).toBe("issues.list takes open, closed, or all")
    expect((await controller.commands.run("setup.run", "7 8 9")).status).toBe("form")
    expect(formOf(store, "setup.run")?.payload.error).toBe("Setup input must be a JSON object")
    await controller.dispose()
  })

  /*
   * Walk W1 (W1-e-triggers-register.json `L92-tokensTranscriptTail`):
   * `/triggers.register --tokens 500000` opened the register form and refused
   * nothing, although 500000 typed into the field and prepared IS refused with
   * the range, before any network call. A limit the line names is the same
   * limit the field names, so it meets the same rule — this door's own
   * (TriggersSeam.limitsRefusal), never a second copy of the sentence.
   */
  test("a flag argument reaches its field and meets the rule the field meets", async () => {
    const { store, controller } = await boot()
    const outcome = await controller.commands.run("triggers.register", "--tokens 500000")
    expect(outcome.status).toBe("form")
    const card = formOf(store, "triggers.register")
    // The limit is the advanced path's: the one-input form does not show it, but the line's value stands as given and meets the rule.
    expect(card?.payload.draft).toEqual({})
    expect(card?.payload.given).toEqual({ tokens: "500000" })
    expect(card?.payload.error).toBe("Token and time limits are whole numbers: --tokens 1..200000, --minutes 1..360.")
    await controller.dispose()
  })

  /*
   * R102 B2: a number INSIDE the range is not told it is outside it. The half
   * that is missing is what the open form is there to collect, so the card
   * asks with its empty field and says nothing.
   */
  test("a limit inside the range is not refused at the door", async () => {
    const { store, controller } = await boot()
    expect((await controller.commands.run("triggers.register", "--tokens 150000")).status).toBe("form")
    expect(formOf(store, "triggers.register")?.payload.given).toEqual({ tokens: "150000" })
    expect(formOf(store, "triggers.register")?.payload.error).toBeUndefined()
    expect((await controller.commands.run("triggers.register", "--minutes 20")).status).toBe("form")
    expect(formOf(store, "triggers.register")?.payload.error).toBeUndefined()
    await controller.dispose()
  })

  test("a repository-shaped token is read as the repository, through the real door", async () => {
    const { store, controller } = await boot()
    expect((await controller.commands.run("triggers.pause", "codeplanesmithers/canary owner-nightly")).status).toBe("form")
    expect(formOf(store, "triggers.pause")?.payload.draft).toEqual({ repo: "codeplanesmithers/canary", slug: "owner-nightly" })
    /* R102 follow-up, through the same door: one repository-shaped token is the repository. */
    expect((await controller.commands.run("triggers.pause", "codeplanesmithers/canary-sandbox")).status).toBe("form")
    expect(formOf(store, "triggers.pause")?.payload.draft).toEqual({ repo: "codeplanesmithers/canary-sandbox" })
    await controller.dispose()
  })
})

describe("THE FORM LAW — filling and submitting", () => {

  test("the agent may submit its own form, and a refusal lands on the card and in its result", async () => {
    const { store, controller } = await boot()
    await execute(controller, "runs.resume")
    const id = "form-runs.resume"
    expect(await execute(controller, "form.submit", id)).toBe("failed: The form still needs: Run id.")
    expect(formOf(store, "runs.resume")?.payload.error).toBe("The form still needs: Run id.")
    /* The form's own sentence about its input carries no kind: it is shown as is. */
    expect(formOf(store, "runs.resume")?.payload.errorKind).toBeUndefined()
    expect(formOf(store, "runs.resume")?.status).toBe("error")
    await execute(controller, "form.set", `${id} runId run-9`)
    // A field commit clears the refusal.
    expect(formOf(store, "runs.resume")?.payload.error).toBeUndefined()
    expect(formOf(store, "runs.resume")?.status).toBe("active")
    const submitted = await execute(controller, "form.submit", id)
    expect(submitted).toContain("asked the user to confirm")
    expect(messages(store).find((message) => message.action?.flow === "runs.resume")?.action?.args).toBe("run-9")
  })
})

describe("THE FORM LAW — every flow's form round-trips through its own grammar", () => {
  test("a filled form assembles to a line the flow's grammar parses, for every flow that takes arguments", async () => {
    const { controller } = await boot()
    const failures: Array<string> = []
    for (const entry of controller.commands.entries()) {
      if (entry.metadata.args === undefined) continue
      const name = nameOf(entry)
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const sample: Record<string, unknown> = {}
      for (const field of fields) {
        if (field.kind === "number") sample[field.name] = 1
        else if (field.kind === "boolean") sample[field.name] = true
        else if (field.kind === "select") sample[field.name] = field.options?.[0]?.value ?? "x1"
        // A repository target is only ever read in its owner/repo shape (RepoContext.splitTrailingRepo).
        else if (field.name === "repo") sample[field.name] = "o/r"
        else if (name === "setup.run" && field.name === "manual") sample[field.name] = { stepId: "fix", prompt: "Keep  spaces" }
        else if ((name === "flow.run" || name === "flow.plan") && field.name === "input") sample[field.name] = { message: "Keep  spaces" }
        else sample[field.name] = "x1"
      }
      const draft = draftFrom(fields, sample)
      const publicFields = fields.filter(field => field.kind !== "write-only")
      if (missingFields(publicFields, draft).length > 0) failures.push(`${name}: the sample left ${missingFields(publicFields, draft).join(", ")} missing`)
      const args = assembleArgs(fields, entry.metadata.form, { ...draft })
      const parsed = payloadFor(name, args === "" ? undefined : args)
      if ("error" in parsed) failures.push(`${name}: "${args}" → ${parsed.error}`)
    }
    expect(failures).toEqual([])
  })
})


/*
 * THE FORM LAW at the submission (ui-flows-chain/api-design/1): a form runs
 * its flow with the NAMED payload it collected. The gate below fills every
 * field of every flow with a DISTINCT value and compares the payload the
 * declaration's own schema decodes with the payload the form intended — a
 * value that landed on the neighbouring field is a failure, which the old
 * "the line parsed" acceptance could not see.
 */

/** A flow's declaration schema as a decoder: the registry types `input` as `Schema.Top`, which carries no service bound. */
const decodeInput = (input: Schema.Top) => Schema.decodeUnknownOption(input as unknown as Schema.Codec<unknown>)

/** Each input property past `Schema.optional`: the shape a sample must take, and whether the schema lets it go. */
const propertyShapes = (input: Schema.Top): ReadonlyMap<string, { readonly tag: string; readonly optional: boolean }> => {
  const ast = input.ast as { _tag: string; propertySignatures?: ReadonlyArray<{ name: PropertyKey; type: any }> }
  const shapes = new Map<string, { readonly tag: string; readonly optional: boolean }>()
  for (const signature of ast.propertySignatures ?? []) {
    const type = signature.type
    const inner = type._tag === "Union" ? type.types.find((member: any) => member._tag !== "Undefined") ?? type : type
    shapes.set(String(signature.name), { tag: String(inner._tag), optional: type._tag === "Union" && type !== inner })
  }
  return shapes
}

/** A distinct value per field, so a value that shifts onto another field is visible in the comparison. */
const sampleFor = (tag: string | undefined, field: FormField, index: number, name: string): unknown => {
  if (name === "setup.run" && field.name === "manual") return { stepId: "fix", prompt: `Keep  spaces ${index}` }
  if (field.kind === "number") return index + 1
  if (field.kind === "boolean") return true
  if (field.kind === "select") return field.options?.[0]?.value ?? `${field.name}-${index}`
  // A list control is one line of space-separated items, so its items carry no space.
  if (tag === "Arrays") return [`src/oné-${index}.ts`, `docs/two-${index}.md`]
  if (tag === "Objects") return { message: `Keep  spaces ${index}` }
  // A repository target is only ever read in its owner/repo shape (RepoContext.splitTrailingRepo).
  if (field.name === "repo") return `owner${index}/repo${index}`
  // Unicode and a path with spaces: a positional line cannot carry either honestly.
  return `${field.name}/a path ${index} ✓`
}

/** The payload a filled form submits: the draft the card holds, named. */
const submissionOf = (
  entry: ReturnType<ReturnType<typeof createCommandRegistry>["entries"]>[number],
  given: Readonly<Record<string, unknown>>
): Record<string, unknown> | string => {
  const fields = formFieldsFor(entry.input, entry.metadata.form)
  const submission = submissionPayload(entry.input, fields, given, draftFrom(fields, given))
  return "error" in submission ? submission.error : submission.payload
}

describe("THE FORM LAW — every flow's form submits its own named payload", () => {
  test("every filled field arrives under its own name, through the flow's input schema", async () => {
    const { controller } = await boot()
    const failures: Array<string> = []
    for (const entry of controller.commands.entries()) {
      if (entry.metadata.args === undefined) continue
      const name = nameOf(entry)
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const shapes = propertyShapes(entry.input)
      const given: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        given[field.name] = sampleFor(shapes.get(field.name)?.tag, field, index, name)
      })
      const payload = submissionOf(entry, given)
      const decoded = typeof payload === "string" ? Option.none() : decodeInput(entry.input)(payload)
      if (Option.isNone(decoded)) {
        failures.push(`${name}: ${JSON.stringify(payload)} is not valid input`)
        continue
      }
      const kept = decoded.value as Record<string, unknown>
      for (const field of fields) {
        if (field.kind === "write-only") {
          if (field.name in kept) failures.push(`${name}.${field.name}: write-only value entered the payload`)
          continue
        }
        if (JSON.stringify(kept[field.name]) !== JSON.stringify(given[field.name])) {
          failures.push(`${name}.${field.name}: submitted ${JSON.stringify(given[field.name])}, ran with ${JSON.stringify(kept[field.name])}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  test("an omitted optional stays omitted instead of shifting the next field's value onto it", async () => {
    const { controller } = await boot()
    const failures: Array<string> = []
    for (const entry of controller.commands.entries()) {
      if (entry.metadata.args === undefined) continue
      const name = nameOf(entry)
      const fields = formFieldsFor(entry.input, entry.metadata.form)
      const optional = fields.filter((field) => !field.required && field.kind !== "boolean")
      // The last optional field alone: everything before it is the gap a positional line closes up.
      const last = optional[optional.length - 1]
      if (last === undefined) continue
      const shapes = propertyShapes(entry.input)
      const given: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        if (field.required || field.name === last.name) given[field.name] = sampleFor(shapes.get(field.name)?.tag, field, index, name)
      })
      const payload = submissionOf(entry, given)
      const decoded = typeof payload === "string" ? Option.none() : decodeInput(entry.input)(payload)
      if (Option.isNone(decoded)) {
        failures.push(`${name}: ${JSON.stringify(payload)} is not valid input`)
        continue
      }
      const kept = decoded.value as Record<string, unknown>
      for (const field of fields) {
        /* A field the schema requires and a `required: false` hint lets stand blank submits as the blank it shows. */
        const expected = field.name in given
          ? given[field.name]
          : shapes.get(field.name)?.optional === false
          ? ""
          : undefined
        if (JSON.stringify(kept[field.name]) !== JSON.stringify(expected)) {
          failures.push(`${name}.${field.name}: expected ${JSON.stringify(expected)}, ran with ${JSON.stringify(kept[field.name])}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  test("a structured control holding text that is not JSON is the form's own refusal, and nothing runs", async () => {
    const { controller } = await boot()
    const entry = controller.commands.find("flow.run")!
    const fields = formFieldsFor(entry.input, entry.metadata.form)
    expect(submissionPayload(entry.input, fields, {}, { name: "coding", input: "{invalid" })).toEqual({
      error: "Input JSON is not valid JSON. Fix it before submitting the form."
    })
    expect(submissionPayload(entry.input, fields, {}, { name: "coding", input: JSON.stringify({ plan: { title: "One" } }) })).toEqual({
      payload: { name: "coding", input: { plan: { title: "One" } } }
    })
  })

  test("change.diff runs with the pins the form filled, never with the line's positions", async () => {
    const calls: Array<{ readonly action: string; readonly args: ReadonlyArray<unknown> }> = []
    const recording = new Proxy({}, {
      get: (_target, property: string) => {
        if (property === "bootstrap") return EVERYTHING
        if (property === "snapshot") return () => ({ surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false })
        if (property === "repositoryFlows") return () => undefined
        if (property === "knownRepositories") return () => new Set<string>()
        return (...args: ReadonlyArray<unknown>) => {
          calls.push({ action: property, args })
          return undefined
        }
      }
    }) as CommandActions
    const registry = createCommandRegistry(recording)
    await registry.submit({ name: "change.diff", payload: { changeId: "c1", to: "1" }, actor: "user", display: "c1 1" })
    expect(calls.filter((call) => call.action === "diffChange")).toEqual([
      { action: "diffChange", args: ["c1", undefined, "1", undefined] }
    ])
  })

  test("the form door submits the draft by name and keeps the assembled line for display only", async () => {
    const { store, controller } = await boot()
    const submitted = spyOn(controller.commands, "submit").mockResolvedValue({ status: "executed" })
    expect(await execute(controller, "change.diff")).toContain("rendered a form")
    const card = formOf(store, "change.diff")!
    await controller.commands.run("form.set", `${card.id} changeId c1`)
    await controller.commands.run("form.set", `${card.id} to 1`)
    const acknowledged = await controller.commands.run("form.submit", card.id)
    const submission = submitted.mock.calls[0]?.[0]
    expect(submission?.payload).toEqual({ changeId: "c1", to: "1" })
    // The line withholds `to` (behind the unset `from` slot it would read back as `from`), so it
    // parses back to exactly what it carries.
    expect(submission?.display).toBe("c1")
    expect(payloadFor("change.diff", submission?.display)).toEqual({ payload: { changeId: "c1" } })
    // The acknowledgment names the withheld value, so the run's `to` is never hidden behind the line.
    expect(acknowledged).toEqual({ status: "executed", value: "submitted /change.diff c1 (+to)" })
  })
})

test("GitHub installation choice has the same missing-input form at slash and agent doors", async () => {
  const { store, controller } = await boot()
  for (const [repo, installationId] of [["ada/hello", 42], ["ada/second", 42], ["acme/api", 99]] as const) {
    await store.dispatch({ type: "github.app-status.loaded", actor: "system", status: {
      repo, installationId, installed: true, configured: true, installUrl: null, rateLimit: null
    } }).isPersisted.promise
  }
  const slash = await controller.commands.run("github.app.choose")
  expect(slash.status).toBe("form")
  const fields = formOf(store, "github.app.choose")?.payload.fields.map(field => ({
    ...field, options: [...(field.options ?? [])].sort((a, b) => a.value.localeCompare(b.value))
  }))
  expect(fields).toEqual([
    { name: "installationId", label: "Installation", kind: "select", required: true,
      options: [{ value: "42", label: "ada" }, { value: "99", label: "acme" }] }
  ])
  expect(await execute(controller, "github.app.choose")).toBe("rendered a form for installationId: ask the user to fill it in")
  expect(formOf(store, "github.app.choose")?.payload.via).toBe("agent")
  await controller.dispose()
})
