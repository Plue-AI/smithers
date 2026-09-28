import { describe, expect, test } from "bun:test"
import { createCommandRegistry } from "../../flows/Commands"
import type { CommandActions } from "../../flows/Flows"
import type { Card, RepositoryFlowsRow } from "../AppState"
import type { ControllerContext } from "./context"
import { createFormsController } from "./forms"

/*
 * The app home's forms (PRODUCT.md D-18; THE FORM LAW): opening an app renders
 * its flow's derived form with one input and one button. The pickers are
 * facts a seam or a card reported — the repository's open issues, its open
 * pull requests, its declared flows — never a guess.
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>
const REPO = "org/repo"

const fixture = (options: { readonly issues?: boolean; readonly sourceIssues?: boolean; readonly prs?: boolean; readonly flows?: boolean; readonly submit?: () => Promise<{ readonly status: "executed"; readonly value: string }> } = {}) => {
  const cards = new Map<string, Card>()
  const base = { status: "active" as const, createdAt: 1, ordinal: 1 }
  if (options.issues !== false) {
    cards.set(`issues-${REPO}`, { ...base, id: `issues-${REPO}`, kind: "issue-list", title: "Issues", payload: { repo: REPO, filter: "open", issues: [
      { number: 42, title: "Footer help link is hard to find", state: "open", author: "ada", labels: [], comments: 0, updatedAt: null, ...(options.sourceIssues ? { source: "github" as const } : {}) },
      { number: 41, title: "Closed one", state: "closed", author: "ada", labels: [], comments: 0, updatedAt: null },
      { number: 40, kind: "chat", title: "A conversation", state: "open", author: "ada", labels: [], comments: 0, updatedAt: null }
    ] } } as Card)
  }
  if (options.prs !== false) {
    cards.set(`prs-${REPO}`, { ...base, id: `prs-${REPO}`, kind: "pr-list", title: "Pull requests", payload: { repo: REPO, landings: [
      { number: 70, title: "Make the help link visible", state: "open", author: "ada", updatedAt: null },
      { number: 69, title: "Landed one", state: "merged", author: "ada", updatedAt: null }
    ] } } as Card)
  }
  const repositoryFlows = new Map<string, RepositoryFlowsRow>()
  if (options.flows !== false) {
    repositoryFlows.set(REPO, { id: REPO, loadedAt: 1, flows: [
      { id: "review", description: "Review the change.", summary: "Review the working-copy change", featured: true, model: null, modelInvocable: true },
      { id: "checks/lint", description: "Lint.", summary: null, featured: false, model: null, modelInvocable: true }
    ] })
  }
  const store = {
    session: () => ({}),
    collections: {
      cards, messages: new Map(), repos: new Map(), workingCopies: new Map(), harnesses: new Map(), models: new Map(), seats: new Map(),
      repositories: new Map([[REPO, { id: REPO, catalog: false }]]), repositoryFlows
    },
    dispatch: (event: { type: string; card?: Card }) => {
      if (event.type === "card.upsert") cards.set(event.card!.id, event.card!)
      return { isPersisted: { promise: Promise.resolve() } }
    }
  }
  const actions = {
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>([REPO]),
    noteCommandRun: () => {},
    traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  } satisfies Partial<CommandActions>
  const commands = createCommandRegistry(actions as unknown as CommandActions)
  const context = { store, commands: options.submit === undefined ? commands : { ...commands, submit: options.submit }, commandActor: "user", baseUrl: "", boundedFetch: async () => new Response("[]", { status: 404 }),
    failures: { report: () => {} } } as unknown as ControllerContext
  const forms = createFormsController(context, { nextOrdinal: () => 1 })
  const card = (id: string): FlowFormCard => cards.get(id) as FlowFormCard
  const field = (id: string, name: string) => card(id).payload.fields.find((candidate) => candidate.name === name)!
  const ask = (name: string, args?: string) => forms.renderFlowForm({ name, args, via: "user" })!
  return { forms, card, field, ask }
}

describe("the Fix an issue app", () => {
  test("issue.implement opened bare asks for one thing, the issue, and offers the repository's open issues", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("issue.implement")
    expect(missing).toEqual(["number"])
    expect(app.card(cardId).payload.submitLabel).toBe("Fix")
    expect(app.card(cardId).payload.fields.map((field) => [field.name, field.label, field.kind, field.required])).toEqual([["number", "Issue", "number", true]])
    expect(app.field(cardId, "number").options).toEqual([{ value: "42", label: "#42 Footer help link is hard to find" }])
  })

  test("a source-only issue list cannot offer GitHub issues to Fix", () => {
    const app = fixture({ sourceIssues: true })
    const { cardId } = app.ask("issue.implement")
    expect(app.field(cardId, "number").options).toEqual([])
  })

  test("with no issues read yet the picker offers nothing rather than a guess", () => {
    const app = fixture({ issues: false })
    expect(app.field(app.ask("issue.implement").cardId, "number").options).toEqual([])
  })
})

describe("the Review a PR app", () => {
  test("prs.triage opened bare asks for the pull request and offers the open ones", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("prs.triage")
    expect(missing).toEqual(["number"])
    expect(app.card(cardId).payload.submitLabel).toBe("Review")
    expect(app.card(cardId).payload.fields.map((field) => [field.name, field.label, field.kind])).toEqual([["number", "PR", "number"]])
    expect(app.field(cardId, "number").options).toEqual([{ value: "70", label: "#70 Make the help link visible" }])
  })

  test("opened again while its review is being submitted, the form opens fresh once that submission is done", async () => {
    let release!: () => void
    const launched = new Promise<void>(resolve => { release = resolve })
    const app = fixture({ submit: async () => { await launched; return { status: "executed", value: "run-requested" } } })
    const { cardId } = app.ask("prs.triage")
    await app.forms.setFormField(cardId, "number", "70")
    const submitted = app.forms.submitForm(cardId)
    await Promise.resolve()
    expect(app.card(cardId).payload.submitting).toBe(true)
    expect(app.ask("prs.triage").cardId).toBe(cardId)
    expect(app.card(cardId).payload.submitting).toBe(true)
    release()
    await submitted
    expect(app.card(cardId).status).toBe("active")
    expect(app.card(cardId).payload.submitting).not.toBe(true)
    expect(app.card(cardId).payload.draft).toEqual({})
  })
})

describe("the Ask the codebase app", () => {
  test("wiki.ask opened bare is a question box and Ask", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("wiki.ask")
    expect(missing).toEqual(["question"])
    expect(app.card(cardId).payload.submitLabel).toBe("Ask")
    expect(app.card(cardId).payload.fields.map((field) => [field.name, field.label, field.kind])).toEqual([["question", "Question", "text"]])
  })
})

describe("the Run it every night app", () => {
  test("triggers.register is one input, the flow, and one button, Schedule; it offers the repository's declared flows and still takes one it does not list", () => {
    const app = fixture()
    const { cardId, missing } = app.ask("triggers.register")
    expect(missing).toEqual(["flow"])
    expect(app.card(cardId).payload.submitLabel).toBe("Schedule")
    expect(app.card(cardId).payload.fields.map((field) => [field.name, field.label, field.kind])).toEqual([["flow", "Flow", "text"]])
    const flow = app.field(cardId, "flow")
    expect(flow.kind).toBe("text")
    expect(flow.options).toEqual([
      { value: "review", label: "review · Review the working-copy change" },
      { value: "checks/lint", label: "checks/lint" }
    ])
    expect(app.field(app.ask("triggers.register").cardId, "flow").options).toEqual(flow.options)
    const bare = fixture({ flows: false })
    expect(bare.field(bare.ask("triggers.register").cardId, "flow").options).toEqual([])
  })
})
