import type { TodoCard } from "../../src/TodoCard.ts"
import { agent, at, ben, issue, person, sha } from "./_shared.ts"

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
export const fixtures = {
  queued: base,
  queued_after: {
    ...base,
    queue: { reason: "merge_order", after: 8, position: 2 },
    merge: { state: "waiting", reason: "order", detail: "T8", on_github: false }
  },
  queued_rebase: { ...base, queue: { reason: "rebase", position: 1 } },
  starting: { ...base, state: "starting", step: "machine", run: { attempt: 1, indicators: [] } },
  working,
  needs_you: {
    ...working,
    state: "needs_you",
    needs_you: { kind: "question", prompt: "Include S3 fields?", since: at },
    first_answer: { by: person, text: "Include them as optional", at },
    steps: [{ id: "implement", label: "Implement", state: "waiting" }, { id: "merge", kind: "wait", state: "next" }],
    run: { attempt: 1, indicators: [{ tone: "wait", text: "Waiting for Ben" }] }
  },
  approval: {
    ...working,
    state: "needs_you",
    needs_you: { kind: "approval", prompt: "Run the schema checks?", since: at, by: agent },
    approval_cleared: false
  },
  conflict: {
    ...working,
    state: "needs_you",
    needs_you: {
      kind: "conflict",
      prompt: "Resolve the card model conflict",
      since: at,
      paths: ["packages/rpc/src/TodoCard.ts"]
    },
    merge: { state: "blocked", reason: "state", detail: "Resolve conflicts", on_github: false }
  },
  moved_off: {
    ...working,
    state: "needs_you",
    needs_you: { kind: "moved_off", prompt: "Return to T12", since: at, by: person, sha }
  },
  foreign_push: {
    ...working,
    state: "needs_you",
    needs_you: {
      kind: "foreign_push",
      prompt: "Review the pushed commit",
      since: at,
      by: { kind: "github", login: "ben", color_index: 3 },
      sha
    }
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
