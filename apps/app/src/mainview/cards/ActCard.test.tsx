/*
 * Review & merge for a TODO this host serves (T-APP-04 review_merge over T-APP-02's TODO card): the person's private
 * Confirm card reads the TODO card the TODO seam keeps live, and its Merge is the TODO card's own control.
 */
import { expect, test } from "bun:test"
import { act } from "react"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { confirmCardFamily } from "./ActCard"
import { reviewMergeOf } from "./TodoCard"
import { createRoot } from "./views/testDom"

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
