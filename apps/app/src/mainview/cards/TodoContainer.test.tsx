import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { describe, expect, test } from "bun:test"
import { act } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { TodoContainer, todoCardFamily, type TodoViewProps } from "./TodoCard"
import type { TodoEntry } from "../state/seams/TodoSeam"
import { TodoView } from "./views/TodoView"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { BEN, createDesignWorld } from "../state/seams/DesignWorld"
import { createRoot } from "./views/testDom"

const mount = (model: TodoCard, role: "owner" | "maintainer" | "member" = "maintainer", answerDraft?: string, availableActions?: readonly CatalogTag[]) => {
  let props!: TodoViewProps
  const dispatches: { tag: CatalogTag; input: unknown }[] = []
  const patches: unknown[] = []
  const card: TodoEntry = { id: `todo:${model.n}`, kind: "todo", title: model.title, status: "active", createdAt: 1, ordinal: 1,
    payload: { n: model.n, model, requests: [], answerDraft, answeredBy: answerDraft ? "maya" : undefined } }
  const View = (value: TodoViewProps) => { props = value; return null }
  renderToStaticMarkup(<TodoContainer card={card} role={role} View={View} view={{ maximized: true, tab: "evidence" }}
    onView={patch => patches.push(patch)} availableActions={availableActions} dispatch={(tag, input) => { dispatches.push({ tag, input }) }} />)
  return { props, dispatches, patches }
}
describe("TODO Container", () => {
  test("a queued TODO without an admitted branch renders and has no Open branch action", () => {
    const model = TodoCardSchema.parse({ ...fixtures.queued.model, branch: undefined })
    const h = mount(model)
    expect(h.props.actions.some(action => action.tag === "branch")).toBe(false)
    expect(renderToStaticMarkup(<TodoView {...h.props} />)).toContain(model.title)
  })
  test("maps every schema fixture, including past attempts and repairs, without owning presentation", () => {
    for (const model of Object.values(fixtures).map(story => story.model)) {
      const h = mount(model)
      const expected = TodoCardSchema.parse(model)
      expect({ ...h.props.model, waits: [] }).toEqual({ ...expected, waits: [] })
      expect(h.props.model.waits.map(({ actions: _, ...wait }) => wait)).toEqual(expected.waits.map(({ actions: _, ...wait }) => wait))
      for (const wait of h.props.model.waits) for (const action of wait.actions) expect(action.args?.wait).toBe(wait.id)
      expect(h.props.view).toEqual({ maximized: true, tab: "evidence" })
      h.props.onView({ tab: "prompt", maximized: false })
      expect(h.patches).toEqual([{ tab: "prompt", maximized: false }])
    }
  })
  test("merge is one control: the served merge block and the viewer's role decide it, whatever the card's other facts", () => {
    for (const place of [1, 2]) for (const role of ["owner", "maintainer", "member"] as const)
      for (const checks of ["pending", "passing", "failing"] as const)
        for (const state of ["ready", "waiting", "blocked", "merging", "done"] as const)
          for (const approval_cleared of [true, false]) for (const revision of ["pr head", "candidate"] as const) for (const draft of [false, true]) {
            const pr = { ...fixtures.in_review.model.pr!, draft }
            const model: TodoCard = { ...fixtures.in_review.model, place, approval_cleared, pr,
              evidence: [{ attempt: 1, revision: revision === "pr head" ? pr.head : "9f3c2e1", items: [{ kind: "github_check", name: "required-ci", required: true, url: "https://github.com/smithersai/smithers/actions/runs/124", state: checks === "passing" ? "passed" : checks === "failing" ? "failed" : "pending" }] }], merge: { state, reason: state === "ready" ? undefined : "checks", detail: "Schema check", on_github: state !== "ready" } }
            const h = mount(model, role)
            const controls = h.props.actions.filter(action => action.tag === "merge")
            expect(controls).toHaveLength(1)
            const canMerge = role !== "member" && state === "ready"
            expect(controls[0]!.disabled === undefined).toBe(canMerge)
            if (canMerge) expect([controls[0]!.label, controls[0]!.primary]).toEqual(["Merge", true])
            h.props.onAction("merge")
            expect(h.dispatches).toEqual(canMerge ? [{ tag: "merge", input: { n: 12, reviewed_head_sha: pr.head } }] : [])
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
  test("foreign answers bind their own wait beside a question and retain the displayed snapshot", () => {
    const question = fixtures.needs_you.model.waits[0]!
    const foreign = fixtures.foreign_push.model.waits[0]!
    const h = mount({ ...fixtures.foreign_push.model, waits: [question, foreign] })
    for (const tag of ["branch.bring-in", "branch.discard-foreign"] as const) h.props.onAction(tag)
    expect(h.dispatches.map(({ input }) => input)).toEqual([
      { branch: "todo/12", id: "wait-foreign-push-1", revision: foreign.sha },
      { branch: "todo/12", id: "wait-foreign-push-1", revision: foreign.sha }
    ])
    expect(h.props.model.waits.map(wait => wait.id)).toEqual([question.id, "wait-foreign-push-1"])
    const newer = mount({ ...fixtures.foreign_push.model, waits: [question, { ...foreign, sha: "newer-head" }] })
    newer.props.onAction("branch.bring-in")
    expect(newer.dispatches[0]?.input).toEqual({ branch: "todo/12", id: "wait-foreign-push-1", revision: "newer-head" })
  })
  test("unbound and non-foreign waits cannot dispatch foreign answers", () => {
    const foreign = fixtures.foreign_push.model.waits[0]!
    for (const wait of [{ ...foreign, sha: undefined }, { ...foreign, id: "" }, { ...foreign, kind: "question" as const }]) {
      const h = mount({ ...fixtures.foreign_push.model, waits: [wait] })
      h.props.onAction("branch.bring-in")
      h.props.onAction("branch.discard-foreign")
      expect(h.dispatches).toEqual([])
    }
  })
  test("foreign push binds its revision; conflict preserves its supplied repair action and paths", () => {
    const foreign = mount(fixtures.foreign_push.model)
    foreign.props.onAction("branch.bring-in")
    foreign.props.onAction("branch.discard-foreign")
    expect(foreign.dispatches).toEqual([
      { tag: "branch.bring-in", input: { branch: "todo/12", id: "wait-foreign-push-1", revision: fixtures.foreign_push.model.waits[0]!.sha } },
      { tag: "branch.discard-foreign", input: { branch: "todo/12", id: "wait-foreign-push-1", revision: fixtures.foreign_push.model.waits[0]!.sha } }
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
    expect(h.props.actions.map(action => action.tag)).toEqual(["branch", "run.inspect"])
    h.props.onAction("todo.drop")
    expect(h.dispatches).toEqual([])
    h.props.onAction("run.inspect")
    expect(h.dispatches).toEqual([{ tag: "run.inspect", input: { id: fixtures.merged.model.run!.id } }])
  })
})

test("independent answer waits dispatch their own IDs even after another answer", () => {
  const question = fixtures.needs_you.model.waits[0]!
  const approval = fixtures.approval.model.waits[0]!
  const model: TodoCard = { ...fixtures.late_answer.model, waits: [question, approval] }
  const h = mount(model)
  // Each wait renders its own Answer; the card's actions row never repeats it.
  expect(h.props.actions.some(action => action.tag === "todo.answer")).toBe(false)
  const actions = h.props.model.waits.flatMap(wait => wait.actions.filter(action => action.tag === "todo.answer"))
  expect(actions).toHaveLength(2)
  expect(actions[1]!.input?.[0]?.choices).toEqual(["Approve", "Deny"])
  for (const action of actions) h.props.onAction(action.tag, { ...action.args, answer: "Yes" })
  expect(h.dispatches).toEqual([
    { tag: "todo.answer", input: { n: 12, wait: question.id, answer: "Yes" } },
    { tag: "todo.answer", input: { n: 12, wait: approval.id, answer: "Yes" } }
  ])
  const late = mount(model, "member", "Late text")
  for (const action of actions) late.props.onAction(action.tag, { ...action.args, answer: "Yes" })
  expect(late.dispatches.map(each => each.tag)).toEqual(["todo.answer", "todo.answer"])
})
test("unavailable card and wait actions are absent and cannot dispatch", () => {
  const model: TodoCard = { ...fixtures.foreign_push.model, waits: [...fixtures.foreign_push.model.waits, ...fixtures.needs_you.model.waits] }
  const h = mount(model, "member", undefined, ["todo.answer", "todo.steer", "todo.amend", "todo.drop"])
  expect(h.props.actions.map(action => action.tag)).toEqual(["todo.steer", "todo.amend", "todo.drop"])
  expect(h.props.model.waits[0]!.actions).toEqual([])
  expect(h.props.model.waits[1]!.actions[0]!.args?.wait).toBe("wait-question-1")
  for (const tag of ["branch", "branch.bring-in", "branch.discard-foreign", "todo.stop", "todo.resume"] as const) h.props.onAction(tag)
  expect(h.dispatches).toEqual([])
  const markup = renderToStaticMarkup(<TodoView {...h.props} />)
  expect(markup).not.toMatch(/>Bring in<|>Discard<|>Open branch<|>Stop<|>Resume</)
  expect(markup).toContain("Answer")
})
test("REST waits with no action args gain independent bindings at the actual View boundary", async () => {
  const first = { ...fixtures.needs_you.model.waits[0]!, id: "first", actions: [{ tag: "todo.answer" as const, label: "Answer", input: [{ name: "answer", label: "Answer", kind: "text" as const, required: true, multiline: true }] }] }
  const second = { ...first, id: "second", prompt: "Second question" }
  const model = { ...fixtures.needs_you.model, waits: [first, second] }
  const h = mount(model)
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host)
  try {
    await act(async () => root.render(<TodoView {...h.props} />))
    for (const [index, field] of [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].entries()) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, index === 0 ? "First answer" : "Second answer")
        field.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await act(async () => field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    }
    expect(h.dispatches).toEqual([
      { tag: "todo.answer", input: { n: 12, wait: "first", answer: "First answer" } },
      { tag: "todo.answer", input: { n: 12, wait: "second", answer: "Second answer" } },
    ])
  } finally { await act(async () => root.unmount()); host.remove() }
})
test("a supplied conflict terminal and Done retain their wait through the Container and View", async () => {
  const model = { ...fixtures.conflict.model, waits: [{ ...fixtures.conflict.model.waits[0]!, actions: [
    { tag: "todo.answer" as const, label: "Done", args: { answer: "done" } },
  ] }] }
  const card: TodoEntry = { id: "todo:12", kind: "todo", title: "Repair", status: "active", createdAt: 1, ordinal: 1, payload: { n: 12, model, requests: [] } }
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host), calls: unknown[] = []
  try {
    await act(async () => root.render(<TodoContainer card={card} role="member" dispatch={(tag, input) => calls.push([tag, input])}
      View={TodoView} view={{ maximized: false }} onView={() => {}} conflictTerminal={<textarea aria-label="Supplied terminal" />} />))
    expect(host.querySelectorAll('[aria-label="Supplied terminal"]')).toHaveLength(1)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-flow="todo.answer"]')!.click())
    expect(calls).toEqual([["todo.answer", { n: 12, wait: "wait-conflict-1", answer: "done" }]])
  } finally { await act(async () => root.unmount()); host.remove() }
})
test("one actions row: Open branch, Inspect, Steer and Amend as plain buttons, Drop; the only form is the wait's Answer", () => {
  const model = { ...fixtures.needs_you.model, first_answer: undefined }
  const h = mount(model)
  expect(h.props.actions.map(action => action.tag)).toEqual(["branch", "run.inspect", "todo.steer", "todo.amend", "todo.drop"])
  expect(h.props.actions.every(action => action.input === undefined)).toBe(true)
  h.props.onAction("todo.steer")
  h.props.onAction("todo.amend")
  expect(h.dispatches).toEqual([{ tag: "todo.steer", input: { n: 12, text: "" } }, { tag: "todo.amend", input: { n: 12, text: "" } }])
  const markup = renderToStaticMarkup(<TodoContainer card={{ id: "todo:12", kind: "todo", title: model.title, status: "active", createdAt: 1, ordinal: 1,
    payload: { n: 12, model, requests: [] } }} role="maintainer" View={TodoView} view={{ maximized: false }} onView={() => {}} dispatch={() => {}} />)
  expect([...markup.matchAll(/<form[^>]*data-flow="([^"]+)"/g)].map(match => match[1])).toEqual(["todo.answer"])
  expect(markup.match(/<textarea/g)).toHaveLength(1)
})
test("on a mounted TODO card, Steer and Amend open Chat on the flow's line instead of running it", async () => {
  const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: BEN })
  const calls: string[] = []
  const emptyInstall = {}
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const stub = { design, store, installSnapshots: { get: () => emptyInstall, subscribe: () => () => {} },
    requestFlowConfirmation: (name: string) => calls.push(`confirm ${name}`),
    changeDraft: (draft: string) => { calls.push(`draft ${draft}`) },
    runCommand: (name: string) => { calls.push(`run ${name}`); return true },
    commands: { submit: (submission: { name: string }) => { calls.push(`submit ${submission.name}`); return Promise.resolve({ status: "executed" }) } } }
  const card = { id: "todo:9", kind: "todo", title: "T9", status: "active", createdAt: 1, ordinal: 1, payload: { n: 9, requests: [] } } as unknown as Parameters<typeof todoCardFamily.todo.render>[0]
  const host = document.body.appendChild(document.createElement("div"))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ControllerTestProvider controller={stub as unknown as AppController}>{todoCardFamily.todo.render(card, { presentation: "embedded" } as never)}</ControllerTestProvider>))
    expect(host.querySelectorAll("form textarea, form input")).toHaveLength(1)
    for (const flow of ["todo.steer", "todo.amend", "todo.drop"]) await act(async () => host.querySelector<HTMLElement>(`.todo-actions > button[data-flow="${flow}"]`)!.click())
    expect(calls).toEqual(["draft /todo.steer T9 ", "run chat.open", "draft /todo.amend T9 ", "run chat.open", "confirm todo.drop"])
  } finally { await act(async () => root.unmount()); host.remove() }
})
test("an install's TODO in review: the served ready enables Merge though evidence names the candidate, and the press sends the PR head", () => {
  // The install serves evidence at the verified candidate; the PR head is its publication, another commit with the same tree.
  const candidate = "0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5", published = "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d"
  const served: TodoCard = { ...fixtures.in_review.model, place: 1,
    pr:{ ...fixtures.in_review.model.pr!, head: published, draft: false },
    evidence: [{ attempt: 1, revision: candidate, items: [{ kind: "check", name: "test", state: "passed" }, { kind: "flow", name: "todo", version: "sha256:1" }] }],
    merge: { state: "ready", on_github: true } }
  const h = mount(served, "owner")
  const merge = h.props.actions.find(action => action.tag === "merge")!
  expect([merge.label, merge.disabled, merge.primary]).toEqual(["Merge", undefined, true])
  h.props.onAction("merge")
  expect(h.dispatches).toEqual([{ tag: "merge", input: { n: 12, reviewed_head_sha: published } }])
  const waiting = mount({ ...served, merge: { state: "waiting", reason: "rechecking", on_github: true } }, "owner")
  expect(waiting.props.actions.find(action => action.tag === "merge")?.disabled).toBeDefined()
  waiting.props.onAction("merge")
  expect(waiting.dispatches).toEqual([])
})

test("a real TODO projection takes precedence over the seeded TODO with the same number", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: BEN })
  const snapshot = {}
  const controller = { store, design, installSnapshots: { get: () => snapshot, subscribe: () => () => {} }, commands: { submit: () => {} } } as unknown as AppController
  const card: TodoEntry = { id: "todo:9", kind: "todo", title: "Actual source prompt", status: "active", createdAt: 1, ordinal: 1,
    payload: { n: 9, requests: [], model: { ...fixtures.queued.model, n: 9, title: "Actual source prompt" } } }
  const markup = renderToStaticMarkup(<ControllerTestProvider controller={controller}>{todoCardFamily.todo.render(card, { presentation: "embedded" } as never)}</ControllerTestProvider>)
  expect(markup).toContain("Actual source prompt")
  expect(markup).not.toContain(design.world().todos.find(todo => todo.ref === "T9")!.title)
})

test("a row the seed opened (no projection, no request) renders the seeded TODO; a pending request never does", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: BEN })
  const snapshot = {}
  const controller = { store, design, installSnapshots: { get: () => snapshot, subscribe: () => () => {} }, commands: { submit: () => {} } } as unknown as AppController
  const seededTitle = design.world().todos.find(todo => todo.ref === "T9")!.title
  const render = (payload: TodoEntry["payload"]) => renderToStaticMarkup(<ControllerTestProvider controller={controller}>{todoCardFamily.todo.render(
    { id: "todo:9", kind: "todo", title: "T9", status: "active", createdAt: 1, ordinal: 1, payload }, { presentation: "embedded" } as never)}</ControllerTestProvider>)
  const seeded = render({ n: 9, requests: [] })
  expect(seeded).toContain('aria-label="TODO T9"')
  expect(seeded).toContain(seededTitle)
  const requested = render({ n: 9, requests: [{ key: "k", owner: "ben", operation: "steer", n: 9, body: { text: "x" }, state: "failed", error: "Stack unavailable" }] })
  expect(requested).not.toContain(seededTitle)
})

 test("Queued Edit is prefilled from revision 2 and saves acceptance through the amendment flow", () => {
  const model = { ...fixtures.queued.model, prompt_revisions: [fixtures.queued.model.prompt_revisions[0]!,
    { ...fixtures.queued.model.prompt_revisions[0]!, text: "PROMPT-B", acceptance: ["Keep the regression"] }] }
  const h = mount(model)
  const edit = h.props.actions.find(action => action.tag === "todo.amend")!
  expect(edit.input?.map(field => field.value)).toEqual(["PROMPT-B", "Keep the regression"])
  const html = renderToStaticMarkup(<TodoView {...h.props} />)
  expect(html).toContain("<summary>Edit</summary>")
  expect(html).toContain("PROMPT-B")
  const amendments = html.slice(html.indexOf("<summary>+1</summary>"), html.indexOf("</details>"))
  expect(amendments).toContain("PROMPT-B")
  expect(amendments).not.toContain(fixtures.queued.model.prompt_revisions[0]!.text)
  h.props.onAction("todo.amend", { text: "PROMPT-C", acceptance: "First check\nSecond check" })
  expect(h.dispatches).toEqual([{ tag: "todo.amend", input: { n: model.n, text: "PROMPT-C", acceptance: ["First check", "Second check"] } }])
  expect(renderToStaticMarkup(<TodoView {...mount(fixtures.working.model).props} />)).not.toContain("<summary>Edit</summary>")
 })

test("only a maintainer or owner can Take over a removed owner's live TODO", () => {
 for (const role of ["owner", "maintainer", "member"] as const) for (const removed of [true, false]) {
  const h = mount({ ...fixtures.queued.model, owner_removed: removed }, role)
  expect(h.props.actions.some(action => action.tag === "todo.takeover")).toBe(removed && role !== "member")
  if (removed && role !== "member") {
   h.props.onAction("todo.takeover")
   expect(h.dispatches).toEqual([{ tag: "todo.takeover", input: { n: fixtures.queued.model.n } }])
  }
 }
 expect(mount({ ...fixtures.merged.model, owner_removed: true }).props.actions.some(action => action.tag === "todo.takeover")).toBe(false)
})
test("only a verified missing-tool failure offers the shared machine-image Draft flow", () => {
 const failure = { ...fixtures.failed.model.failure!, missing_tool: { name: "figlet", file: ".smithers/machine.json" } }
 const h = mount({ ...fixtures.failed.model, failure })
 h.props.onAction("image.add")
 expect(h.dispatches).toEqual([{ tag: "image.add", input: { name: "figlet" } }])
 expect(mount({ ...fixtures.failed.model, failure: { ...failure, missing_tool: undefined } }).props.actions.some(action => action.tag === "image.add")).toBe(false)
})


test("served TODO cards retain composed takeover, image and run controls", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const snapshot = { model: { github: { signed_in: true, owner: "ben" } } }
  const controller = { store, design: createDesignWorld({ enabled: false }), installSnapshots: { get: () => snapshot, subscribe: () => () => {} }, commands: { submit: () => {} } } as unknown as AppController
  const render = (model: TodoCard) => renderToStaticMarkup(<ControllerTestProvider controller={controller}>{todoCardFamily.todo.render(
    { id: `todo:${model.n}`, kind: "todo", title: model.title, status: "active", createdAt: 1, ordinal: 1, payload: { n: model.n, model, requests: [] } }, { presentation: "embedded" } as never)}</ControllerTestProvider>)
  expect(render({ ...fixtures.queued.model, owner_removed: true })).toContain('data-flow="todo.takeover"')
  expect(render({ ...fixtures.failed.model, failure: { ...fixtures.failed.model.failure!, missing_tool: { name: "figlet", file: ".smithers/machine.json" } } })).toContain('data-flow="image.add"')
  expect(render(fixtures.working.model)).toContain('data-flow="todo.stop"')
  expect(render(fixtures.paused.model)).toContain('data-flow="todo.resume"')
})
