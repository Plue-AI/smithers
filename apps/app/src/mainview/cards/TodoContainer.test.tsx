import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { TodoContainer, type TodoViewProps } from "./TodoContainer"
import type { TodoEntry } from "../state/seams/TodoSeam"

const mount = (model: TodoCard, role: "owner" | "maintainer" | "member" = "maintainer", answerDraft?: string) => {
  let props!: TodoViewProps
  const dispatches: { tag: CatalogTag; input: unknown }[] = []
  const patches: unknown[] = []
  const card: TodoEntry = { id: `todo:${model.n}`, kind: "todo", title: model.title, status: "active", createdAt: 1, ordinal: 1,
    payload: { n: model.n, model, requests: [], answerDraft, answeredBy: answerDraft ? "maya" : undefined } }
  const View = (value: TodoViewProps) => { props = value; return null }
  renderToStaticMarkup(<TodoContainer card={card} role={role} View={View} view={{ maximized: true, tab: "evidence" }}
    onView={patch => patches.push(patch)} dispatch={(tag, input) => { dispatches.push({ tag, input }) }} />)
  return { props, dispatches, patches }
}
describe("TODO Container", () => {
  test("maps every schema fixture, including past attempts and repairs, without owning presentation", () => {
    for (const model of Object.values(fixtures).map(story => story.model)) {
      const h = mount(model)
      expect(h.props.model).toEqual(TodoCardSchema.parse(model))
      expect(h.props.view).toEqual({ maximized: true, tab: "evidence" })
      h.props.onView({ tab: "prompt", maximized: false })
      expect(h.patches).toEqual([{ tab: "prompt", maximized: false }])
    }
  })
  test("merge is one control across order, role, checks, merge block and approval clearing", () => {
    for (const place of [1, 2]) for (const role of ["owner", "maintainer", "member"] as const)
      for (const checks of ["pending", "passing", "failing"] as const)
        for (const state of ["ready", "waiting", "blocked", "merging", "done"] as const)
          for (const approval_cleared of [true, false]) {
            const model: TodoCard = { ...fixtures.in_review.model, place, approval_cleared,
              evidence: [{ attempt: 1, revision: fixtures.in_review.model.pr!.head, items: [{ kind: "github_check", name: "required-ci", required: true, url: "https://github.com/smithersai/smithers/actions/runs/124", state: checks === "passing" ? "passed" : checks === "failing" ? "failed" : "pending" }] }], merge: { state, reason: state === "ready" ? undefined : "checks", detail: "Schema check", on_github: state !== "ready" } }
            const h = mount(model, role)
            const controls = h.props.actions.filter(action => action.tag === "merge")
            expect(controls).toHaveLength(1)
            const canMerge = place === 1 && role !== "member" && checks === "passing" && state === "ready"
            expect(controls[0]!.disabled === undefined).toBe(canMerge)
            h.props.onAction("merge")
            expect(h.dispatches).toEqual(canMerge ? [{ tag: "merge", input: { n: 12, reviewed_head_sha: model.pr!.head } }] : [])
          }
  })
  test("order and GitHub refusals reach the sole merge control verbatim", () => {
    expect(mount(fixtures.draft_pr.model).props.actions.find(action => action.tag === "merge")?.label).toBe("Merges after T8")
    const detail = "Protected branch update failed: Required review is missing"
    const h = mount({ ...fixtures.in_review.model, merge: { state: "blocked", reason: "github", detail, on_github: true } })
    expect(h.props.actions.find(action => action.tag === "merge")?.label).toBe(detail)
  })
  test("question input dispatches the bound number and preserves late text for steer", () => {
    const unanswered = { ...fixtures.needs_you.model, first_answer: undefined }
    const h = mount(unanswered)
    h.props.onAction("todo.answer", { n: "999", answer: "Yes\nkeep the fixtures" })
    expect(h.dispatches).toEqual([{ tag: "todo.answer", input: { n: 12, wait: "wait-question-1", answer: "Yes\nkeep the fixtures" } }])
    expect(mount({ ...fixtures.needs_you.model, waits: [] }).props.actions.some(action => action.tag === "todo.answer")).toBe(false)
    const late = mount(unanswered, "member", "My late answer")
    expect(late.props.answer).toEqual({ text: "My late answer", answered_by: "maya" })
    expect(late.props.actions.some(action => action.tag === "todo.answer")).toBe(false)
    expect(late.props.actions.find(action => action.tag === "todo.steer")?.label).toBe("Send as steer")
    late.props.onAction("todo.steer")
    expect(late.dispatches).toEqual([{ tag: "todo.steer", input: { n: 12, text: "My late answer" } }])
  })
  test("foreign push binds its revision; conflict preserves its supplied repair action and paths", () => {
    const foreign = mount(fixtures.foreign_push.model)
    foreign.props.onAction("branch.bring-in")
    foreign.props.onAction("branch.discard-foreign")
    expect(foreign.dispatches).toEqual([
      { tag: "branch.bring-in", input: { branch: "todo/12", revision: fixtures.foreign_push.model.waits[0]!.sha } },
      { tag: "branch.discard-foreign", input: { branch: "todo/12", revision: fixtures.foreign_push.model.waits[0]!.sha } }
    ])
    const conflict = mount(fixtures.conflict.model)
    expect(conflict.props.model.waits[0]?.paths).toEqual(["packages/rpc/src/TodoCard.ts", "packages/rpc/src/CardPrimitives.ts"])
    expect(conflict.props.actions.some(action => action.tag === "todo.answer")).toBe(false)
    conflict.props.onAction("branch", { name: "todo/12", wait: "wait-conflict-1" })
    expect(conflict.dispatches).toEqual([{ tag: "branch", input: { name: "todo/12" } }])
  })
  test("state filters controls and keeps unavailable actions from dispatching", () => {
    expect(mount(fixtures.paused.model).props.actions.some(action => action.tag === "todo.resume")).toBe(true)
    expect(mount(fixtures.working.model).props.actions.some(action => action.tag === "todo.stop")).toBe(true)
    const failed = mount(fixtures.failed.model)
    expect(failed.props.actions.some(action => action.tag === "todo.retry")).toBe(true)
    failed.props.onAction("todo.retry", { text: "Use the schema" })
    expect(failed.dispatches).toEqual([{ tag: "todo.retry", input: { n: 12, text: "Use the schema" } }])
    expect(mount(fixtures.failed_permanent.model).props.actions.some(action => action.tag === "todo.retry")).toBe(false)
    const h = mount(fixtures.merged.model)
    expect(h.props.actions.map(action => action.tag)).toEqual(["branch"])
    h.props.onAction("todo.drop")
    expect(h.dispatches).toEqual([])
  })
})

test("independent answer waits dispatch their own IDs even after another answer", () => {
  const question = fixtures.needs_you.model.waits[0]!
  const approval = fixtures.approval.model.waits[0]!
  const model: TodoCard = { ...fixtures.late_answer.model, waits: [question, approval] }
  const h = mount(model)
  const actions = h.props.actions.filter(action => action.tag === "todo.answer")
  expect(actions).toHaveLength(2)
  expect(actions[1]!.input?.[0]?.choices).toEqual(["Approve", "Deny"])
  for (const action of actions) h.props.onAction(action.tag, { ...action.args, answer: "Yes" })
  expect(h.dispatches).toEqual([
    { tag: "todo.answer", input: { n: 12, wait: question.id, answer: "Yes" } },
    { tag: "todo.answer", input: { n: 12, wait: approval.id, answer: "Yes" } }
  ])
  expect(mount(model, "member", "Late text").props.actions.filter(action => action.tag === "todo.answer")).toHaveLength(2)
})
test("passing checks from an earlier head cannot enable Merge", () => {
  const h = mount({ ...fixtures.in_review.model, pr: { ...fixtures.in_review.model.pr!, head: "new-head" } })
  expect(h.props.actions.find(action => action.tag === "merge")?.disabled).toBeDefined()
  h.props.onAction("merge")
  expect(h.dispatches).toEqual([])
})
