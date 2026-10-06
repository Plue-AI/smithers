import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { fixtures } from "@smthrs/rpc/fixtures/Confirm"
import type { ConfirmCard } from "@smthrs/rpc/ConfirmCard"
import type { Card } from "../state/AppState"
import type { CardActions } from "./CardFamily"
import { approvalCardFamily, confirmCardProps, memberConfirmations, memberConfirmCardProps } from "./ApprovalCard"
import { renderConfirmCard } from "./CardRenderers"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

test("private confirmation buttons dispatch approval flows with the row ID, never its initiating tag", () => {
  for (const kind of ["todo", "branch", "flow", "agent", "wiki"] as const) {
    const id = "10000000-0000-4000-8000-000000000001"
    const [row] = memberConfirmations([{ id, state: "pending", command: "todo.drop", revision: "revision-2", expires_at: "2099-01-01T00:00:00Z",
      payload: { input: {}, card: { ...fixtures.one_click.model, action: { tag: "todo.drop", verb: "Drop" }, subject: { kind, ref: "subject", revision: "revision-2" } } } }])
    const calls: unknown[] = []
    const props = memberConfirmCardProps(row!, (tag, input) => calls.push({ tag, input }))
    const host = document.createElement("div"), root = createRoot(host)
    try {
      flushSync(() => root.render(renderConfirmCard(props)))
      expect([...host.querySelectorAll("button")].map(button => button.dataset.flow)).toEqual(["approval.approve", "approval.deny"])
      host.querySelector<HTMLButtonElement>('[data-flow="approval.approve"]')!.click()
      host.querySelector<HTMLButtonElement>('[data-flow="approval.deny"]')!.click()
      expect(calls).toEqual([{ tag: "approval.approve", input: { cardId: `confirmation:${id}` } }, { tag: "approval.deny", input: { cardId: `confirmation:${id}` } }])
      expect(props.model.subject).toEqual({ kind, ref: "subject", revision: "revision-2" })
    } finally { flushSync(() => root.unmount()) }
  }
})

test("malformed/private-model receipts never become visible confirmation rows", () => {
  expect(memberConfirmations(undefined)).toEqual([])
  expect(memberConfirmations([{ id: "private", state: "pending" }, null, { payload: fixtures.one_click.model }])).toEqual([])
})

test("a terminal Confirm collapses to one receipt with no private prompt or stale controls", () => {
  const host = document.createElement("div"), root = createRoot(host)
  try {
    const props = confirmCardProps({ ...fixtures.done.model, text: "Do not repeat the private prompt" })
    flushSync(() => root.render(renderConfirmCard({ ...props, actions: [{ tag: "approval.approve", label: "Approve" }] })))
    expect(host.querySelectorAll("button")).toHaveLength(0)
    expect(host.querySelectorAll("p")).toHaveLength(1)
    expect(host.textContent).not.toContain("Do not repeat")
  } finally { flushSync(() => root.unmount()) }
})

const render = (model: ConfirmCard): string => {
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    flushSync(() => root.render(renderConfirmCard(confirmCardProps(model))))
    expect(host.querySelectorAll("button")).toHaveLength(0)
    return host.textContent ?? ""
  } finally {
    flushSync(() => root.unmount())
  }
}

for (const kind of ["one_click", "review_merge"] as const) {
  const model = fixtures[kind].model
  test(`${kind} preserves the projection but exposes no executable action`, () => {
    const props = confirmCardProps(model)
    expect(props.model).toBe(model)
    expect(props.actions).toEqual([])
    expect(render(model)).toContain(kind === "one_click" ? "Keep the S3 fields optional" : "Card model contracts")
    for (const tag of [model.action.tag, "merge.confirm", "confirm.cancel"] as const) {
      try {
        props.onAction(tag, { confirmation: "c-1", revision: "4bc79ae" })
        throw new Error("Expected missing consumer refusal")
      } catch (error) {
        expect(error).toMatchObject({ status: 503, error: {
          class: "infra", code: "confirmation_unavailable", message: "Confirmation unavailable"
        } })
      }
    }
  })
  for (const result of ["done", "cancelled", "expired"] as const) {
    test(`${kind} ${result} is a receipt without controls`, () => {
      const receipt = fixtures.done.model.receipt!
      const text = render({ ...model, receipt: { ...receipt, result } })
      expect(text).toContain(result === "done" ? "Ben" : result === "cancelled" ? "Cancelled" : "Expired")
    })
  }
}

test("stale review approval stays separate from the current evidence", () => {
  const model = fixtures.review_merge.model
  expect(render({ ...model, review: { ...model.review!, approved_revision: "1b2c3d4" } }))
    .toContain("Approved 1b2c3d4 · Review 4bc79ae")
})

for (const state of ["pending", "failed", "passed"] as const) {
  test(`required check ${state} never enables Merge without its consumer`, () => {
    const model = fixtures.review_merge.model
    const review = model.review!
    const text = render({ ...model, review: { ...review,
      evidence: { ...review.evidence, items: [{ kind: "github_check", name: "required-ci", required: true, state, url: "https://github.com/smithersai/smithers/actions/runs/1" }] },
      merge: state === "pending" ? { state: "waiting", reason: "rechecking", on_github: false }
        : state === "failed" ? { state: "blocked", reason: "checks", on_github: false } : review.merge
    } })
    expect(text).toContain("required-ci")
    if (state === "pending") expect(text).toContain("Checks running")
  })
}

for (const kind of ["todo", "branch", "flow", "agent", "wiki"] as const) {
  test(`${kind} subject and revision pass through unchanged without authority`, () => {
    const model = { ...fixtures.one_click.model, subject: { kind, ref: "subject", revision: "revision-2" } }
    expect(confirmCardProps(model).model.subject).toEqual({ kind, ref: "subject", revision: "revision-2" })
  })
}

test("legacy rows stay unmounted even when a decision callback exists", () => {
  const card: Extract<Card, { kind: "approval" }> = {
    id: "legacy", kind: "approval", title: "Owner?", status: "active", ordinal: 0, createdAt: 0,
    payload: { capability: "Owner?", question: { kind: "ask", prompt: "Owner?" } }
  }
  let effects = 0
  const actions = { onDecideApproval: () => { effects++ } } as unknown as CardActions
  expect(approvalCardFamily.approval.render(card, actions)).toBeNull()
  expect(effects).toBe(0)
})
