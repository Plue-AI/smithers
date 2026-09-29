import { describe, expect, test } from "bun:test"
import { createCommandRegistry } from "../../flows/Commands"
import type { CommandActions } from "../../flows/Flows"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createFormsController } from "./forms"
import { settled } from "../TestFixtures"

/*
 * files.read's Path (CT105). A repository path is not a closed enumeration:
 * the inventory a host answers with lists part of the tree, so a nested or
 * brand-new path could never be named by a <select>. The field is text and
 * the inventory is suggestion only. A select field would make `coerce` refuse
 * every value that is not already an option, and `setFormField` drops a
 * refused edit, so a path typed before the inventory landed would stop
 * tracking the box the human is typing in. These tests drive the real
 * controller — renderFlowForm, setFormField, submitForm — and the real flow.
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>

const REPO = "smithersai/smithers"

const fixture = (read: (path: string) => string | { readonly value: string } = () => ({ value: "# Smithers" }), inventory?: () => Promise<Response>) => {
  const cards = new Map<string, Card>()
  const reads: Array<string> = []
  const store = {
    session: () => ({ activeRepoKey: REPO }),
    collections: { cards, messages: new Map(), repos: new Map(), repositories: new Map(), workingCopies: new Map(), harnesses: new Map() },
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
    readFile: async (path: string) => {
      reads.push(path)
      return read(path)
    },
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  } satisfies Partial<CommandActions>
  const commands = createCommandRegistry(actions as unknown as CommandActions)
  const context = { store, commands, commandActor: "user", baseUrl: "", boundedFetch: inventory ?? (() => new Promise<Response>(() => {})) } as unknown as ControllerContext
  let ordinal = 0
  const forms = createFormsController(context, { nextOrdinal: () => ++ordinal })
  const card = (id: string): FlowFormCard => cards.get(id) as FlowFormCard
  const field = (id: string, name: string) => card(id).payload.fields.find((candidate) => candidate.name === name)!
  /** What refreshFileList writes when the repository answers (forms.ts), with no network. */
  const inventoryArrives = (id: string, paths: ReadonlyArray<string>): void => {
    const existing = card(id)
    cards.set(id, { ...existing, payload: { ...existing.payload,
      fields: existing.payload.fields.map((candidate) => candidate.optionsFrom === "files"
        ? { ...candidate, options: paths.map((path) => ({ value: path, label: path })) }
        : candidate) } })
  }
  const ask = (name: "files.read" | "files.list") => forms.renderFlowForm({ name, args: undefined, via: "user" })!
  return { forms, reads, card, field, inventoryArrives, ask }
}

describe("the path a file flow asks for", () => {
  test.each([false, true])("a held inventory survives typing but not a reopened form (reopen: %s)", async reopen => {
    let begin!: () => void, release!: (response: Response) => void
    const started = new Promise<void>(resolve => { begin = resolve })
    const held = new Promise<Response>(resolve => { release = resolve })
    let calls = 0
    const app = fixture(undefined, () => {
      if (++calls !== 1) return new Promise<Response>(() => {})
      begin()
      return held
    })
    const { cardId } = app.ask("files.read")
    await started
    await app.forms.setFormField(cardId, "path", "REA")
    if (reopen) app.ask("files.read")
    release(Response.json([{ name: "README.md", path: "README.md", type: "file" }]))
    await settled()
    expect(app.field(cardId, "path").options ?? []).toEqual(reopen ? [] : [{ value: "README.md", label: "README.md" }])
    if (reopen) expect(app.card(cardId).payload.draft.path).toBeUndefined()
    else expect(app.card(cardId).payload.draft.path).toBe("REA")
  })

  test("files.read asks for it as a text field that carries the inventory as suggestions", () => {
    const app = fixture()
    const rendered = app.ask("files.read")
    expect(rendered.missing).toEqual(["path"])
    const path = app.field(rendered.cardId, "path")
    expect(path.kind).toBe("text")
    expect(path.optionsFrom).toBe("files")
  })

  test("a path typed before the inventory arrives keeps growing after it lands, and submits exactly what was typed", async () => {
    const app = fixture()
    const { cardId } = app.ask("files.read")
    await app.forms.setFormField(cardId, "path", "REA")
    expect(app.card(cardId).payload.draft["path"]).toBe("REA")
    app.inventoryArrives(cardId, ["README.md", "src/index.ts"])
    expect(app.card(cardId).payload.draft["path"]).toBe("REA")
    for (const typed of ["READ", "READM", "README", "README.", "README.m", "README.md"]) {
      expect(await app.forms.setFormField(cardId, "path", typed)).toBeUndefined()
      expect(app.card(cardId).payload.draft["path"]).toBe(typed)
    }
    await app.forms.submitForm(cardId, undefined, undefined)
    expect(app.reads).toEqual(["README.md"])
    expect(app.card(cardId).status).toBe("acted")
    expect(app.card(cardId).payload.error).toBeUndefined()
  })

  test("clearing the typed path leaves the same text field, with the inventory still offered", async () => {
    const app = fixture()
    const { cardId } = app.ask("files.read")
    await app.forms.setFormField(cardId, "path", "REA")
    app.inventoryArrives(cardId, ["README.md", "src/index.ts"])
    await app.forms.setFormField(cardId, "path", "")
    expect(app.card(cardId).payload.draft["path"]).toBeUndefined()
    const path = app.field(cardId, "path")
    expect(path.kind).toBe("text")
    expect(path.options?.map((option) => option.value)).toEqual(["README.md", "src/index.ts"])
  })

  test("a path another suggestion extends submits as typed, never as the longer suggestion", async () => {
    const app = fixture()
    const { cardId } = app.ask("files.read")
    app.inventoryArrives(cardId, ["src/index.ts", "src/index.ts.map"])
    for (const typed of ["src", "src/", "src/index", "src/index.ts"]) {
      await app.forms.setFormField(cardId, "path", typed)
      expect(app.card(cardId).payload.draft["path"]).toBe(typed)
    }
    await app.forms.submitForm(cardId, undefined, undefined)
    expect(app.reads).toEqual(["src/index.ts"])
  })

  test("a path the inventory does not carry is submitted as typed, and the flow's own refusal is what the card shows", async () => {
    const app = fixture((path) => `Path not found: ${path} in ${REPO}`)
    const { cardId } = app.ask("files.read")
    app.inventoryArrives(cardId, ["README.md"])
    await app.forms.setFormField(cardId, "path", "docs/UNLISTED.md")
    expect(app.card(cardId).payload.draft["path"]).toBe("docs/UNLISTED.md")
    await app.forms.submitForm(cardId, undefined, undefined)
    expect(app.reads).toEqual(["docs/UNLISTED.md"])
    expect(app.card(cardId).status).toBe("error")
    expect(app.card(cardId).payload.error).toBe(`Path not found: docs/UNLISTED.md in ${REPO}`)
    /* The flow's words are the run's detail, never the form's own sentence. */
    expect(app.card(cardId).payload.errorKind).toBe("run")
    await app.forms.setFormField(cardId, "path", "README.md")
    expect(app.card(cardId).payload.error).toBeUndefined()
    expect(app.card(cardId).payload.errorKind).toBeUndefined()
  })

  test("files.list asks for its path as a text field too", () => {
    const app = fixture()
    const rendered = app.ask("files.list")
    expect(app.field(rendered.cardId, "path").kind).toBe("text")
  })
})
