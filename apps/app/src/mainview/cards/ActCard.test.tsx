/*
 * Review & merge for a TODO this host serves (T-APP-04 review_merge over T-APP-02's TODO card): the person's private
 * Confirm card reads the TODO card the TODO seam keeps live, and its Merge is the TODO card's own control. A
 * confirmation the install serves (T-APP-04 one_click, J6 step 3c) reads the row the TODO seam keeps from
 * GET /api/confirmations; off an install the seeded design world's A✓ acts still render.
 */
import { expect, test } from "bun:test"
import { act } from "react"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import type { ServedConfirmation } from "../state/seams/TodoSeam"
import { memoryStorage, silentAgent, waitFor } from "../state/TestFixtures"
import { confirmCardFamily } from "./ActCard"
import { reviewMergeOf } from "./TodoCard"
import { createRoot } from "./views/testDom"

const createAppController = scopedControllers()
const model = fixtures.in_review.model
const head = model.pr!.head
const viewer = { login: "maya", name: "maya", avatar_url: PlaceholderAvatarUrl }

test("Review & merge carries the TODO card's one Merge control, bound to the PR head the person reviews", () => {
  const review = reviewMergeOf(model, "maintainer", viewer)!
  expect(review.model).toMatchObject({ kind: "review_merge", action: { tag: "merge", verb: "Merge" }, subject: { kind: "todo", ref: "T12", revision: head },
    review: { title: model.title, place: 1, pr: { number: model.pr!.number, url: model.pr!.url }, merge: model.merge } })
  expect(review.model.receipt).toBeUndefined()
  expect(review.actions.map(action => [action.tag, action.label, action.disabled?.reason])).toEqual([["confirm.cancel", "Cancel", undefined], ["merge", "Merge", undefined]])
  expect(review.actions[0]!.command_input).toEqual({ confirmation: "merge:todo:12", revision: head })
  expect(review.actions[1]!.command_input as unknown).toEqual({ n: 12, reviewed_head_sha: head })
  expect(reviewMergeOf(model, "member", viewer)!.actions[1]!.disabled).toEqual({ reason: "A maintainer merges" })
  const blocked = reviewMergeOf({ ...model, merge: { state: "blocked", reason: "github", detail: "1 approving review required on GitHub", on_github: true } }, "owner", viewer)!
  expect(blocked.actions[1]!.disabled).toEqual({ reason: "1 approving review required on GitHub" })
  const merged = reviewMergeOf({ ...model, state: "merged", merge: { state: "done", on_github: true } }, "owner", viewer)!
  expect(merged.actions).toEqual([])
  expect(merged.model.receipt).toEqual({ by: viewer, result: "done", at: "", text: "Merged T12" })
  expect(reviewMergeOf({ ...model, pr: undefined }, "owner", viewer)).toBeUndefined()
})

test("on an install, Review & merge of a served TODO whose evidence names the candidate, not the PR head: ready enables Merge and the press submits the PR head", async () => {
  // The install serves evidence at the verified candidate; the PR head is its publication, another commit with the same tree.
  const candidate = "0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5", published = "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d"
  const served: TodoCard = { ...model, pr:{ ...model.pr!, head: published, draft: false },
    evidence: [{ attempt: 1, revision: candidate, items: [{ kind: "check", name: "test", state: "passed" }, { kind: "flow", name: "todo", version: "sha256:1" }] }],
    merge: { state: "ready", on_github: true } }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "todo:12", kind: "todo", title: "T12", status: "active", createdAt: 1, ordinal: 1,
    payload: { n: 12, requests: [], model: served } } }).isPersisted.promise
  const submitted: unknown[] = []
  const install = { model: { github: { signed_in: true, owner: "maya" } } }
  const stub = { store, installSnapshots: { get: () => install, subscribe: () => () => {} },
    commands: { submit: (submission: unknown) => { submitted.push(submission); return Promise.resolve({ status: "executed" }) } } }
  const host = document.body.appendChild(document.createElement("div"))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ControllerTestProvider controller={stub as unknown as AppController}>{confirmCardFamily.confirm.render({ id: "confirm:merge:todo:12",
      kind: "confirm", title: "Merge T12 into main?", status: "active", createdAt: 2, ordinal: 2, audience_member_id: "maya", payload: { id: "merge:todo:12" } }, { presentation: "embedded" } as never)}</ControllerTestProvider>))
    expect(host.textContent).toContain(`rev ${candidate}`)
    const merge = host.querySelector<HTMLButtonElement>('button[data-flow="merge"]')!
    expect(merge.disabled).toBe(false)
    await act(async () => merge.click())
    expect(submitted).toEqual([{ name: "merge", payload: { n: 12, reviewed_head_sha: published }, actor: "user", originCardId: "confirm:merge:todo:12" }])
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("on an install, only the person it was opened for sees Review & merge; Merge submits the reviewed head and Merged settles it", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  const todo = (value: TodoCard) => store.dispatch({ type: "card.upsert", actor: "system", card: { id: "todo:12", kind: "todo", title: "T12", status: "active", createdAt: 1, ordinal: 1,
    payload: { n: 12, requests: [], model: value } } }).isPersisted.promise
  await todo(model)
  const submitted: unknown[] = []
  const install = { model: { github: { signed_in: true, owner: "maya" } } }
  const stub = { store, installSnapshots: { get: () => install, subscribe: () => () => {} },
    commands: { submit: (submission: unknown) => { submitted.push(submission); return Promise.resolve({ status: "executed" }) } } }
  const confirm = (audience: string) => confirmCardFamily.confirm.render({ id: "confirm:merge:todo:12", kind: "confirm", title: "Merge T12 into main?", status: "active",
    createdAt: 2, ordinal: 2, audience_member_id: audience, payload: { id: "merge:todo:12" } }, { presentation: "embedded" } as never)
  const host = document.body.appendChild(document.createElement("div"))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ControllerTestProvider controller={stub as unknown as AppController}>{confirm("ben")}</ControllerTestProvider>))
    expect(host.textContent).toBe("")
    await act(async () => root.render(<ControllerTestProvider controller={stub as unknown as AppController}>{confirm("maya")}</ControllerTestProvider>))
    expect(host.querySelector('[aria-label="Merge T12 into main?"]')).not.toBeNull()
    expect(host.textContent).toContain(`#${model.pr!.number}`)
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-flow="merge"]')!.click())
    expect(submitted).toEqual([{ name: "merge", payload: { n: 12, reviewed_head_sha: head }, actor: "user", originCardId: "confirm:merge:todo:12" }])
    await act(async () => { await todo({ ...model, state: "merged", merge: { state: "done", on_github: true } }) })
    expect(host.querySelector('[aria-label="Merged T12"]')).not.toBeNull()
    expect(host.querySelector('button[data-flow="merge"]')).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("on an install, a served confirmation shows only its member the agent's ask with Commit and Cancel; approved, it is its receipt", async () => {
  const id = "9b2f6c1e-3a4d-4e5f-8a6b-7c8d9e0f1a2b"
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  const asked = { kind: "one_click", action: { tag: "todo.new", verb: "Commit" }, summary: "Commit Log retry counts", subject: { kind: "todo", ref: "Log retry counts" },
    text: "Count retries per webhook.", asked_by: { kind: "agent", agent: "claude-code", id: "agent-session-5e55", session_id: "5e55", for_member: viewer, avatar_url: PlaceholderAvatarUrl, color_index: 0 } }
  let rows: ReadonlyArray<ServedConfirmation> = [{ id, state: "pending", card: asked }]
  const listeners = new Set<() => void>()
  const served = (next: ReadonlyArray<ServedConfirmation>) => act(async () => { rows = next; for (const listener of listeners) listener() })
  const submitted: unknown[] = []
  const stub = { store, confirmations: { get: () => rows, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    commands: { submit: (submission: unknown) => { submitted.push(submission); return Promise.resolve({ status: "executed" }) } } }
  const confirm = (audience: string | null) => confirmCardFamily.confirm.render({ id: `confirm:confirmation:${id}`, kind: "confirm", title: "Commit Log retry counts?",
    status: "active", createdAt: 2, ordinal: 2, audience_member_id: audience, payload: { id: `confirmation:${id}` } }, { presentation: "embedded" } as never)
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")].map(button => [button.dataset.flow, button.textContent])
  const host = document.body.appendChild(document.createElement("div"))
  const root = createRoot(host)
  const show = (audience: string | null) => act(async () => root.render(<ControllerTestProvider controller={stub as unknown as AppController}>{confirm(audience)}</ControllerTestProvider>))
  try {
    for (const other of ["ben", null]) {
      await show(other)
      expect(host.textContent).toBe("")
    }
    await show("maya")
    expect(host.querySelector('[aria-label="Commit Log retry counts?"]')).not.toBeNull()
    expect(host.textContent).toContain("Count retries per webhook.")
    expect(buttons()).toEqual([["todo.new", "Commit⏎"], ["confirm.cancel", "Cancel"]])
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-flow="todo.new"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-flow="confirm.cancel"]')!.click())
    expect(submitted).toEqual([
      { name: "todo.new", payload: { confirmation: id }, actor: "user", originCardId: `confirm:confirmation:${id}` },
      { name: "confirm.cancel", payload: { confirmation: `confirmation:${id}`, revision: id }, actor: "user", originCardId: `confirm:confirmation:${id}` }
    ])
    await served([{ id, state: "approved", todo: 5, card: { ...asked, receipt: { by: viewer, result: "done", at: "2026-10-05T08:01:00Z", text: "Committed T5" } } }])
    expect(host.querySelector('[aria-label="Committed T5"]')).not.toBeNull()
    expect(buttons()).toEqual([])
    await served([{ id, state: "rejected", card: { ...asked, receipt: { by: viewer, result: "cancelled", at: "2026-10-05T08:01:00Z" } } }])
    expect(host.querySelector(".confirm-receipt")?.textContent).toBe("Cancelled")
    expect(buttons()).toEqual([])
    // A row this host has not served, or a card that does not parse, renders nothing.
    await served([{ id, state: "pending", card: { ...asked, kind: "nope" } }])
    expect(host.textContent).toBe("")
    await served([])
    expect(host.textContent).toBe("")
  } finally { await act(async () => root.unmount()); host.remove() }
})

test("off an install, the seeded design world's A✓ act still renders its own flow and Cancel; cancelled, it is its receipt", async () => {
  const cloud: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  const controller = createAppController(store, silentAgent, { bootstrap: cloud,
    fetchImpl: async input => new URL(String(input), "https://cloud.test").pathname.startsWith("/api/todos") ? Response.json({}, { status: 404 }) : Response.json({}) })
  controller.send("drop T11")
  await waitFor(() => controller.design.world().acts.length === 1)
  const act0 = controller.design.world().acts[0]!
  await waitFor(() => store.collections.cards.has(`design:confirm:act:${act0.id}`))
  const card = store.collections.cards.get(`design:confirm:act:${act0.id}`)!
  const host = document.body.appendChild(document.createElement("div"))
  const root = createRoot(host)
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")].map(button => [button.dataset.flow, button.textContent])
  try {
    await act(async () => root.render(<ControllerTestProvider controller={controller}>{confirmCardFamily.confirm.render(card as never, { presentation: "embedded" } as never)}</ControllerTestProvider>))
    expect(host.querySelector('[aria-label="Drop T11 log-retries?"]')).not.toBeNull()
    expect(buttons()).toEqual([["todo.drop", "Drop⏎"], ["confirm.cancel", "Cancel"]])
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-flow="confirm.cancel"]')!.click())
    await waitFor(() => controller.design.world().acts[0]?.state === "cancelled")
    await act(async () => {})
    expect(host.querySelector(".confirm-receipt")?.textContent).toBe("Cancelled")
    expect(buttons()).toEqual([])
  } finally { await act(async () => root.unmount()); host.remove() }
})
