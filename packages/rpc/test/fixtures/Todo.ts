import type { Action } from "../../src/CardAction.ts"
import type { TodoCard, TodoWait } from "../../src/TodoCard.ts"
import { agent, at, ben, claude_code, github_user, issue, person, sha, will_person } from "./_shared.ts"

const later = "2026-10-02T17:51:00.000Z"
const base: TodoCard = {
  n: 12,
  title: "Card model contracts",
  state: "queued",
  owner: ben,
  place: 1,
  queue: { reason: "machine", position: 1 },
  prompt_revisions: [{ text: "Publish card projections", by: person, at }],
  issue: { number: issue.number, url: issue.url, fixes: true },
  branch: { id: "todo-12", name: "todo/12", machine: "ready" },
  present: [person, agent],
  steps: [{ id: "plan", label: "Plan", state: "next" }, { id: "merge", kind: "wait", state: "next" }],
  waits: [],
  steers: [],
  evidence: [],
  merge: { state: "waiting", reason: "state", on_github: false },
  lessons: 0
}
const pr: NonNullable<TodoCard["pr"]> = {
  number: 3475,
  url: "https://github.com/smithersai/smithers/pull/3475",
  head: sha,
  draft: false,
  checks: "passing",
  included_items: [12]
}
const working: TodoCard = {
  ...base,
  state: "working",
  step: "implement",
  queue: undefined,
  steps: [
    { id: "plan", label: "Plan", detail: "Read the card contract", state: "done" },
    { id: "implement", label: "Implement", state: "current" },
    { id: "check", label: "Check", state: "next" },
    { id: "merge", kind: "wait", state: "next" }
  ],
  run: { attempt: 1, indicators: [] },
  prompt_revisions: [...base.prompt_revisions, { text: "Include recursive branch fixtures", by: agent, at }]
}
const waiting: TodoCard = {
  ...working,
  state: "needs_you",
  steps: [{ id: "implement", label: "Implement", state: "waiting" }, { id: "merge", kind: "wait", state: "next" }],
  run: { attempt: 1, indicators: [{ tone: "wait", text: "Waiting for a person since 17:42" }] }
}
const answer = (wait: string): Action => ({
  tag: "todo.answer",
  label: "Answer",
  args: { n: "12", wait },
  primary: true,
  input: [{ name: "answer", label: "Answer", kind: "text", required: true, multiline: true }]
})
const question: TodoWait = {
  id: "wait-question-1",
  kind: "question",
  prompt: "Include S3 fields?",
  since: later,
  by: agent,
  actions: [answer("wait-question-1")]
}
const approval: TodoWait = {
  id: "wait-approval-1",
  kind: "approval",
  prompt: "Run the schema checks?",
  since: at,
  by: agent,
  actions: [{
    tag: "todo.answer",
    label: "Answer",
    args: { n: "12", wait: "wait-approval-1" },
    primary: true,
    input: [{ name: "answer", label: "Answer", kind: "choice", choices: ["Approve", "Deny"], required: true }]
  }]
}
const conflict: TodoWait = {
  id: "wait-conflict-1",
  kind: "conflict",
  prompt: "Resolve the card model conflict",
  since: at,
  paths: ["packages/rpc/src/TodoCard.ts", "packages/rpc/src/CardPrimitives.ts"],
  actions: [{ tag: "branch", label: "Resolve", args: { name: "todo/12" }, primary: true }]
}
const movedOff: TodoWait = {
  id: "wait-moved-off-1",
  kind: "moved_off",
  prompt: "Return to T12",
  since: at,
  by: person,
  sha,
  actions: [
    { tag: "todo.return-to-item", label: "Return to T12", args: { n: "12" }, primary: true },
    { tag: "todo.keep-moved", label: "Keep for now", args: { n: "12" } }
  ]
}
const foreignPush: TodoWait = {
  id: "wait-foreign-push-1",
  kind: "foreign_push",
  prompt: "Review the pushed commit",
  since: at,
  by: github_user,
  sha,
  actions: [
    { tag: "branch.bring-in", label: "Bring in", args: { branch: "todo/12", revision: sha }, primary: true },
    { tag: "branch.discard-foreign", label: "Discard", args: { branch: "todo/12", revision: sha } }
  ]
}
const steers: TodoCard["steers"] = [
  { text: "Keep the S3 fields optional", by: person, at },
  { text: "Name the fixture after the state", by: claude_code, at: later }
]
export const fixtures = {
  queued: base,
  queued_after: {
    ...base,
    queue: { reason: "merge_order", after: 8, position: 2 },
    merge: { state: "waiting", reason: "order", detail: "T8", on_github: false }
  },
  queued_rebase: { ...base, queue: { reason: "rebase", position: 1 }, rebase_pending: { onto: "T8" } },
  starting: { ...base, state: "starting", step: "machine", run: { attempt: 1, indicators: [] } },
  working,
  steered: { ...working, steers },
  late_answer: {
    ...working,
    first_answer: { by: person, text: "Include them as optional", at },
    steers: [{ text: "Make them required", by: will_person, at: later }]
  },
  needs_you: { ...waiting, waits: [question] },
  approval: { ...waiting, waits: [approval], approval_cleared: false },
  conflict: {
    ...waiting,
    waits: [conflict],
    merge: { state: "blocked", reason: "state", detail: "Resolve conflicts", on_github: false }
  },
  moved_off: { ...waiting, waits: [movedOff] },
  foreign_push: { ...waiting, waits: [foreignPush] },
  two_waits: {
    ...waiting,
    waits: [conflict, question],
    steers,
    merge: { state: "blocked", reason: "state", detail: "Resolve conflicts", on_github: false }
  },
  paused: {
    ...working,
    state: "paused",
    steps: [{ id: "implement", label: "Implement", state: "paused" }, { id: "merge", kind: "wait", state: "next" }]
  },
  failed: {
    ...working,
    state: "failed",
    failure: { step: "check", class: "test_failure", message: "Home rejected the limited state", retryable: true },
    steps: [{ id: "check", label: "Check", state: "failed" }, { id: "merge", kind: "wait", state: "next" }],
    run: { attempt: 2, indicators: [{ tone: "thrash", text: "Home schema failed 3 times" }] },
    evidence: [{
      attempt: 1,
      revision: sha,
      items: [{
        kind: "test",
        label: "Schema test failure",
        url: "https://github.com/smithersai/smithers/actions/runs/123"
      }]
    }, { attempt: 2, revision: sha, items: [{ kind: "log", label: "Check output" }] }],
    pr: { ...pr, checks: "failing" }
  },
  failed_permanent: {
    ...working,
    state: "failed",
    failure: { step: "source", class: "permission_denied", message: "Repository access refused", retryable: false }
  },
  in_review: {
    ...working,
    state: "in_review",
    step: "merge",
    steps: [{ id: "check", label: "Check", state: "done" }, { id: "merge", kind: "wait", state: "held", since: at }],
    pr,
    approval_cleared: true,
    merge: { state: "ready", on_github: false },
    evidence: [{ attempt: 1, revision: sha, items: [{ kind: "test", label: "52 schema tests passed" }] }]
  },
  rebase_pending: {
    ...working,
    state: "in_review",
    step: "merge",
    steps: [{ id: "check", label: "Check", state: "done" }, { id: "merge", kind: "wait", state: "held", since: at }],
    pr,
    rebase_pending: { onto: "T8" },
    merge: { state: "waiting", reason: "rechecking", on_github: false }
  },
  draft_pr: {
    ...working,
    state: "in_review",
    pr: { ...pr, draft: true, draft_after: 8, checks: "pending", included_items: [8, 12] },
    merge: { state: "waiting", reason: "order", detail: "T8", on_github: false }
  },
  merging: { ...working, state: "in_review", pr, merge: { state: "merging", on_github: false } },
  merged: {
    ...working,
    state: "merged",
    steps: [{ id: "merge", kind: "wait", state: "done" }],
    pr,
    merged_via: 15,
    merge: { state: "done", on_github: true },
    lessons: 1
  },
  dropped: { ...base, state: "dropped", queue: undefined, present: [] }
} satisfies Record<string, TodoCard>
