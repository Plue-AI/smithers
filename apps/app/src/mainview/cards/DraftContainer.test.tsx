import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { DraftCard } from "@smthrs/rpc/DraftCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Draft"
import { DraftContainer, type DraftViewProps } from "./DraftContainer"
import type { DraftEntry } from "../state/seams/TodoSeam"

const mount = (model: DraftCard, request?: DraftEntry["payload"]["request"], memberId = "ben") => {
  let props: DraftViewProps | undefined
  const dispatches: { tag: CatalogTag; input: unknown }[] = []
  const patches: unknown[] = []
  const card: DraftEntry = { id: "draft:1", kind: "draft", title: model.title, status: "active", createdAt: 1, ordinal: 1,
    audience_member_id: model.private ? "ben" : null, payload: { ...model, idempotencyKey: "commit-1", request } }
  const View = (value: DraftViewProps) => { props = value; return null }
  renderToStaticMarkup(<DraftContainer card={card} memberId={memberId} View={View} view={{ maximized: false }}
    onView={patch => patches.push(patch)} dispatch={(tag, input) => { dispatches.push({ tag, input }) }} />)
  return { props, dispatches, patches }
}
test("Draft maps all story models and their unmerged placement options", () => {
  for (const fixture of Object.values(fixtures).map(story => story.model)) {
    const h = mount(fixture)
    expect(h.props?.model.place.options).toEqual(fixture.place.options)
    expect(h.props?.model.issue).toEqual(fixture.issue)
    expect(h.props?.model.seed).toEqual(fixture.seed)
    h.props?.onView({ maximized: true })
    expect(h.patches).toEqual([{ maximized: true }])
  }
})
test("Commit has one stable key and placement, field edits go through form.set", () => {
  const h = mount(fixtures.before.model)
  h.props!.onAction("todo.new")
  h.props!.onAction("todo.new")
  expect(h.dispatches).toEqual(Array(2).fill({ tag: "todo.new", input: { cardId: "draft:1", idempotencyKey: "commit-1",
    text: fixtures.before.model.prompt, title: fixtures.before.model.title, acceptance: fixtures.before.model.acceptance, before: 8 } }))
  expect(h.props!.gestures.set?.tag).toBe("form.set")
  h.props!.onAction("form.set", { cardId: "other", field: "prompt", value: "New\nprompt" })
  expect(h.dispatches[2]).toEqual({ tag: "form.set", input: { cardId: "draft:1", field: "prompt", value: "New\nprompt" } })
  h.props!.onAction("draft.discard")
  expect(h.dispatches[3]).toEqual({ tag: "draft.discard", input: { draft: "draft:1" } })
})
test("pending Commit disables repeat submission, Discard and editing; failure permits retry", () => {
  const request = { key: "commit-1", owner: "ben", operation: "create" as const, body: {}, state: "accepted" as const }
  const h = mount(fixtures.append.model, request)
  h.props!.onAction("todo.new")
  h.props!.onAction("draft.discard")
  h.props!.onAction("form.set", { field: "title", value: "Can't edit" })
  expect(h.dispatches).toEqual([])
  expect(h.props!.actions.find(action => action.tag === "todo.new")?.disabled?.reason).toBe("Commit pending")
  const failed = mount(fixtures.append.model, { ...request, state: "failed", error: "Connection lost" })
  expect(failed.props!.failure).toBe("Connection lost")
  failed.props!.onAction("todo.new")
  expect(failed.dispatches).toHaveLength(1)
})
test("amend commits its placed TODO; committed draft offers only its TODO link", () => {
  const amend = mount(fixtures.amend.model)
  amend.props!.onAction("todo.amend")
  expect(amend.dispatches).toEqual([{ tag: "todo.amend", input: { n: 9, text: fixtures.amend.model.prompt, cardId: "draft:1", idempotencyKey: "commit-1" } }])
  const committed = mount(fixtures.committed.model, undefined, "maya")
  expect(committed.props!.actions.map(action => action.tag)).toEqual(["todo"])
  expect(committed.props!.gestures.set).toBeUndefined()
  committed.props!.onAction("todo")
  expect(committed.dispatches).toEqual([{ tag: "todo", input: { n: 12 } }])
})
test("private drafts do not project to other members; incomplete placement disables Commit", () => {
  expect(mount(fixtures.append.model, undefined, "maya").props).toBeUndefined()
  const h = mount({ ...fixtures.before.model, place: { mode: "before", options: fixtures.before.model.place.options, n: 99 } })
  h.props!.onAction("todo.new")
  expect(h.dispatches).toEqual([])
})
