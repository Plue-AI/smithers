import { flowArgs } from "../flows/FlowArgs"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { approvalActionId } from "../state/ApprovalReference"
import { ApprovalsInboxCardBody } from "./RunsCards"
import { answerValue } from "./RunsCards"
import { questionOf } from "./ApprovalQuestion"

/*
 * Answering a gate that asks a question.
 *
 * Run-3 of `coding/request` on Smithers Cloud asked "which service owns the
 * retry budget?" through a HumanTask and parked forever. Two buttons cannot
 * answer that, so the row renders the prompt and a box — and the answer rides
 * the same callback a decision does, with the value attached.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type InboxCard = Extract<Card, { kind: "approvals-inbox" }>
type InboxRow = InboxCard["payload"]["approvals"][number]

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

const click = async (host: HTMLElement, selector: string): Promise<void> => {
  const element = host.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.click()
  // React commits the handler's state outside the click; one macrotask is the
  // render these assertions read.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Types into the answer box; input events publish its draft through form.set. */
const type = (host: HTMLElement, selector: string, value: string): void => {
  const element = host.querySelector<HTMLTextAreaElement>(selector)
  if (element === null) throw new Error(`no element for ${selector}`)
  element.value = value
}

const row = (overrides: Partial<InboxRow> = {}): InboxRow => ({
  runId: "run-3",
  requestId: "coding-clarification#1",
  title: "Which service owns the retry budget?",
  approval: { target: { _tag: "Node", runId: "run-3", requestId: "coding-clarification#1" } },
  requestedAt: 42,
  ...overrides
})

const inbox = (approvals: ReadonlyArray<InboxRow>): InboxCard => ({
  id: "inbox",
  kind: "approvals-inbox",
  title: "Approvals",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: "smithersai/smithers", approvals: [...approvals] }
})

const recorder = () => {
  const calls: Array<[string, string, unknown]> = []
  return {
    calls,
    onDecideApproval: (id: string, decision: "approved" | "denied", answer?: unknown) =>
      void calls.push([id, decision, answer])
  }
}

describe("an approvals-inbox row that asks a question", () => {
  const asked = row({
    question: { kind: "ask", prompt: "Which service owns the retry budget?", name: "coding-clarification", attempt: 1, maxAttempts: 3 }
  })

  test("renders the prompt and a box instead of approve and deny", async () => {
    const { calls, onDecideApproval } = recorder()
    const host = mount(<ApprovalsInboxCardBody card={inbox([asked])} onDecideApproval={onDecideApproval} />)

    expect(host.querySelector("[data-testid=approval-answer]")?.textContent)
      .toContain("Which service owns the retry budget?")
    // A question is not granted: the two decision buttons are gone.
    expect(host.querySelector("[data-decision=approve]")).toBeNull()

    type(host, "[data-testid=approval-answer-text]", "the scheduler owns it")
    await click(host, "[data-testid=approval-answer-send]")

    // The same row id a decision takes, with the answer attached.
    expect(calls).toEqual([[approvalActionId("inbox", asked), "approved", "the scheduler owns it"]])
  })

  test("refuses an empty answer where the person can still fix it", async () => {
    const { calls, onDecideApproval } = recorder()
    const host = mount(<ApprovalsInboxCardBody card={inbox([asked])} onDecideApproval={onDecideApproval} />)

    await click(host, "[data-testid=approval-answer-send]")

    expect(calls).toEqual([])
    expect(host.querySelector("[role=alert]")?.textContent ?? "").toContain("Type an answer")
  })

  test("says which attempt a re-asked question is on", () => {
    const host = mount(
      <ApprovalsInboxCardBody
        card={inbox([row({ question: { ...asked.question!, attempt: 2 } })])}
        onDecideApproval={() => {}}
      />
    )
    expect(host.textContent).toContain("Attempt 2 of 3")
  })

  test("answers a confirm with a boolean and a select with the option", async () => {
    const confirmed = recorder()
    const confirm = mount(
      <ApprovalsInboxCardBody
        card={inbox([row({ question: { kind: "confirm", prompt: "Ship it?" } })])}
        onDecideApproval={confirmed.onDecideApproval}
      />
    )
    await click(confirm, "[data-testid=approval-answer-no]")
    expect(confirmed.calls[0]?.[2]).toBe(false)

    const chosen = recorder()
    const select = mount(
      <ApprovalsInboxCardBody
        card={inbox([row({ question: { kind: "select", prompt: "Which build?", options: ["canary", "stable"] } })])}
        onDecideApproval={chosen.onDecideApproval}
      />
    )
    await click(select, "[data-testid=approval-answer-option-stable]")
    expect(chosen.calls[0]?.[2]).toBe("stable")
  })

  test("keeps a capability gate on its two buttons", () => {
    const host = mount(<ApprovalsInboxCardBody card={inbox([row()])} onDecideApproval={() => {}} />)
    expect(host.querySelector("[data-testid=approval-answer]")).toBeNull()
    expect(host.querySelector("[data-decision=approve]")).not.toBeNull()
  })
})

describe("an approvals-inbox row that asks to raise a USD budget", () => {
  const park = row({
    requestId: "budget/run-3/usd",
    title: "Raise the USD budget from $1.00 to $2.20?",
    approval: { target: { _tag: "Node", runId: "run-3", requestId: "budget/run-3/usd" } }
  })

  test("shows the dollar question and raises the ceiling on Approve", async () => {
    const { calls, onDecideApproval } = recorder()
    const host = mount(<ApprovalsInboxCardBody card={inbox([park])} onDecideApproval={onDecideApproval} />)

    expect(host.textContent).toContain("Raise the USD budget from $1.00 to $2.20?")
    // A raise is granted, not answered: no box, the two decision buttons.
    expect(host.querySelector("[data-testid=approval-answer]")).toBeNull()
    await click(host, "[data-decision=approve]")

    expect(calls).toEqual([[approvalActionId("inbox", park), "approved", undefined]])
  })

  test("stops the run on Deny", async () => {
    const { calls, onDecideApproval } = recorder()
    const host = mount(<ApprovalsInboxCardBody card={inbox([park])} onDecideApproval={onDecideApproval} />)

    await click(host, "[data-decision=deny]")

    expect(calls).toEqual([[approvalActionId("inbox", park), "denied", undefined]])
  })
})

describe("shaping what was typed", () => {
  test("parses a json answer and refuses one that is not json", () => {
    const question = { kind: "json", prompt: "Which services?" } as const
    expect(answerValue(question, ' {"owner": "scheduler"} ')).toEqual({ value: { owner: "scheduler" } })
    expect(answerValue(question, "scheduler")).toMatchObject({ error: expect.stringContaining("not JSON") })
    expect(answerValue(question, "  ")).toMatchObject({ error: expect.stringContaining("JSON answer") })
  })

  test("trims prose and refuses whitespace", () => {
    const question = { kind: "ask", prompt: "Who?" } as const
    expect(answerValue(question, "  scheduler \n")).toEqual({ value: "scheduler" })
    expect(answerValue(question, " \t ")).toMatchObject({ error: expect.stringContaining("Type an answer") })
  })
})

describe("reading a gateway row", () => {
  const base = {
    runId: "run-3",
    requestId: "coding-clarification#1",
    title: "Which service owns the retry budget?",
    payload: {} as never,
    requestedAt: 42,
    status: "pending" as const
  }

  test("takes the question from a wait held below the run", () => {
    expect(questionOf({
      ...base,
      waitRunId: "prepare-plan",
      request: { kind: "select", prompt: "Which build?", name: "release", options: ["canary"], attempt: 2, maxAttempts: 3 }
    })).toEqual({ kind: "select", prompt: "Which build?", name: "release", options: ["canary"], attempt: 2, maxAttempts: 3 })
  })

  test("falls back to a box a person types in when the wait declared nothing", () => {
    expect(questionOf({ ...base, waitRunId: "prepare-plan", request: null }))
      .toEqual({ kind: "ask", prompt: "Which service owns the retry budget?" })
  })

  test("reads a capability gate as no question at all", () => {
    expect(questionOf({ ...base, request: { kind: "ask", prompt: "not a wait" } })).toBeUndefined()
  })
})


test("the answer box restores the projected draft and every input uses its exact question-bound form field", () => {
  const asked = row({ question: { kind: "ask", prompt: "Who owns the budget?" }, answerDraft: { question: "a".repeat(64), text: "saved answer" } })
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = (value: InboxRow) => flushSync(() => root.render(<ApprovalsInboxCardBody
    card={inbox([value])} onDecideApproval={() => {}}
    onRunCommand={(name, args) => { calls.push([name, args]) }} />))
  try {
    render(asked)
    const box = host.querySelector<HTMLTextAreaElement>("[data-testid=approval-answer-text]")!
    expect(box.value).toBe("saved answer")
    box.value = 'new "owner"\nwith details'
    flushSync(() => box.dispatchEvent(new Event("input", { bubbles: true })))
    expect(calls).toEqual([["form.set", flowArgs("form.set", { cardId: approvalActionId("inbox", asked), field: `answer:${asked.answerDraft!.question}`, value: box.value })]])
    render({ ...asked, question: { ...asked.question!, attempt: 2 }, answerDraft: { question: "b".repeat(64), text: "" } })
    expect(host.querySelector<HTMLTextAreaElement>("[data-testid=approval-answer-text]")!.value).toBe("")
    render({ ...asked, answerDraft: { question: "a".repeat(64), text: "restored after reopen" } })
    expect(host.querySelector<HTMLTextAreaElement>("[data-testid=approval-answer-text]")!.value).toBe("restored after reopen")
  } finally {
    flushSync(() => root.unmount())
    host.remove()
  }
})
