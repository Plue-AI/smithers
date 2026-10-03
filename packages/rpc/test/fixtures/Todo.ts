import type { Action } from "../../src/CardAction.ts"
import type { Evidence } from "../../src/CardPrimitives.ts"
import type { TodoCard, TodoWait } from "../../src/TodoCard.ts"
import { agent, at, ben, claude_code, github_user, issue, person, sha, will, will_person } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const later = "2026-10-02T17:51:00.000Z"
const n = { n: "12" }
const base: TodoCard = {
  n: 12,
  title: "Card model contracts",
  state: "queued",
  owner: ben,
  place: 1,
  queue: { reason: "machine", position: 1 },
  prompt_revisions: [{
    text: "Publish card projections",
    acceptance: ["Every fixture parses", "Unknown states fail"],
    by: person,
    at
  }],
  issue: { number: issue.number, url: issue.url, fixes: true },
  branch: { id: "todo-12", name: "todo/12", machine: { state: "waiting", position: 1 } },
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
  head: "4bc79ae",
  draft: false,
  included_items: [12]
}
const working: TodoCard = {
  ...base,
  state: "working",
  step: "Implement",
  queue: undefined,
  branch: { ...base.branch, machine: { state: "awake" } },
  steps: [
    { id: "plan", label: "Plan", detail: "Read the card contract", state: "done" },
    { id: "implement", label: "Implement", state: "current" },
    { id: "check", label: "Check", state: "next" },
    { id: "merge", kind: "wait", state: "next" }
  ],
  run: { id: "run-41", attempt: 1, indicators: [] },
  prompt_revisions: [...base.prompt_revisions, {
    text: "Include recursive branch fixtures",
    acceptance: ["Branch trees nest"],
    by: claude_code,
    at
  }]
}
const waiting: TodoCard = {
  ...working,
  state: "needs_you",
  steps: [{ id: "implement", label: "Implement", state: "waiting" }, { id: "merge", kind: "wait", state: "next" }],
  run: { id: "run-41", attempt: 1, indicators: [{ tone: "wait", text: "Waiting for a person since 17:42" }] }
}
const answer = (wait: string): Action => ({
  tag: "todo.answer",
  label: "Answer",
  args: { ...n, wait },
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
    args: { ...n, wait: "wait-approval-1" },
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
  ssh_line: "ssh todo-12@mac-mini.local",
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
    { tag: "todo.return-to-item", label: "Return to T12", args: n, primary: true },
    { tag: "todo.keep-moved", label: "Keep for now", args: n }
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
const passed: Evidence = {
  attempt: 1,
  revision: "4bc79ae",
  items: [
    { kind: "diff", files: 14, added: 412, removed: 96 },
    { kind: "check", name: "pnpm test", state: "passed", took_s: 48 },
    {
      kind: "github_check",
      name: "required-ci",
      state: "passed",
      required: true,
      url: "https://github.com/smithersai/smithers/actions/runs/124"
    },
    { kind: "review", summary: "Schemas match the spec; fixtures cover every state" },
    { kind: "usage", tokens: 182_000, time_s: 914 },
    { kind: "flow", name: "todo", version: "v3" },
    { kind: "model_access", label: "OpenAI key · gpt-5.2" }
  ]
}
const failedChecks: Evidence = {
  attempt: 2,
  revision: "9e8f7a6",
  items: [
    { kind: "diff", files: 3, added: 40, removed: 12 },
    {
      kind: "check",
      name: "pnpm test",
      state: "failed",
      took_s: 31,
      log_url: "https://github.com/smithersai/smithers/actions/runs/123"
    },
    {
      kind: "github_check",
      name: "required-ci",
      state: "failed",
      required: true,
      url: "https://github.com/smithersai/smithers/actions/runs/123"
    },
    {
      kind: "github_check",
      name: "preview",
      state: "pending",
      required: false,
      url: "https://github.com/smithersai/smithers/actions/runs/125"
    }
  ]
}
const steer: Action = {
  tag: "todo.steer",
  label: "Steer",
  args: n,
  input: [{ name: "text", label: "Steer", kind: "text", required: true, multiline: true }]
}
const inspect: Action = { tag: "run.inspect", label: "Inspect", args: { id: "run-41" } }
const openBranch: Action = { tag: "branch", label: "Open branch", args: { name: "todo/12" } }
const merge: Action = { tag: "merge", label: "Merge", args: n, primary: true }
const drop: Action = { tag: "todo.drop", label: "Drop", args: n }

export const fixtures = {
  queued: story("Waiting for a machine", base, {
    actions: [{ tag: "todo.amend", label: "Amend", args: n, input: steer.input }, drop],
    expect: ["Card model contracts", "Publish card projections"]
  }),
  queued_after: story(
    "Queued behind T8",
    {
      ...base,
      queue: { reason: "merge_order", after: 8, position: 2 },
      merge: { state: "waiting", reason: "order", detail: "T8", on_github: false }
    },
    { actions: [drop], expect: ["Card model contracts", "T8"] }
  ),
  queued_rebase: story(
    "Queued for a rebase",
    { ...base, queue: { reason: "rebase", position: 1 }, rebase_pending: { onto: "T8" } },
    { actions: [drop], expect: ["Card model contracts", "T8"] }
  ),
  queued_daily_limit: story(
    "Queued at the daily limit",
    { ...base, queue: { reason: "daily_limit", position: 1 } },
    { actions: [drop], expect: ["Card model contracts"] }
  ),
  starting: story(
    "Starting on a waking machine",
    {
      ...base,
      state: "starting",
      queue: undefined,
      branch: { ...base.branch, machine: { state: "waking" } },
      run: { id: "run-41", attempt: 1, indicators: [] }
    },
    { actions: [inspect], expect: ["Card model contracts"] }
  ),
  working: story("Working on Implement", working, {
    actions: [steer, { tag: "todo.stop", label: "Stop", args: n }, inspect, openBranch],
    expect: ["Card model contracts", "Implement"]
  }),
  steered: story("Working with two steers", { ...working, steers }, {
    actions: [steer, inspect],
    expect: ["Keep the S3 fields optional", "Name the fixture after the state"]
  }),
  late_answer: story(
    "A late answer kept behind Send as steer",
    {
      ...working,
      first_answer: { by: person, text: "Include them as optional", at },
      steers: [{ text: "Make them required", by: will_person, at: later }]
    },
    {
      actions: [{ ...steer, label: "Send as steer" }],
      expect: ["Include them as optional", "Make them required", "Send as steer"]
    }
  ),
  needs_you: story("Needs you: a question", { ...waiting, waits: [question] }, {
    actions: [steer],
    expect: ["Include S3 fields?", "Answer"]
  }),
  approval: story("Needs you: an approval", { ...waiting, waits: [approval], approval_cleared: false }, {
    expect: ["Run the schema checks?", "Approve"]
  }),
  conflict: story(
    "Needs you: a rebase conflict",
    {
      ...waiting,
      waits: [conflict],
      merge: { state: "blocked", reason: "state", detail: "Resolve conflicts", on_github: false }
    },
    {
      actions: [openBranch],
      expect: ["Resolve the card model conflict", "packages/rpc/src/TodoCard.ts", "ssh todo-12@mac-mini.local"]
    }
  ),
  moved_off: story("Needs you: moved off the item", { ...waiting, waits: [movedOff] }, {
    expect: ["Return to T12", "Keep for now"]
  }),
  foreign_push: story("Needs you: an outside push", { ...waiting, waits: [foreignPush] }, {
    expect: ["Review the pushed commit", "octocat", "Bring in", "Discard"]
  }),
  two_waits: story(
    "Two open waits at once",
    {
      ...waiting,
      waits: [conflict, question],
      steers,
      merge: { state: "blocked", reason: "state", detail: "Resolve conflicts", on_github: false }
    },
    { actions: [steer], expect: ["Resolve the card model conflict", "Include S3 fields?"] }
  ),
  paused: story(
    "Paused by a person",
    {
      ...working,
      state: "paused",
      pause: { reason: "person", since: at },
      branch: { ...base.branch, machine: { state: "asleep" } },
      steps: [{ id: "implement", label: "Implement", state: "paused" }, { id: "merge", kind: "wait", state: "next" }]
    },
    { actions: [{ tag: "todo.resume", label: "Resume", args: n, primary: true }, drop], expect: ["Implement"] }
  ),
  paused_by_budget: story(
    "Paused by the daily token budget",
    {
      ...working,
      state: "paused",
      pause: { reason: "daily_token_budget", owner: will, since: at, resume_at: "2026-10-03T00:00:00.000Z" },
      branch: { ...base.branch, machine: { state: "asleep" } },
      steps: [{ id: "implement", label: "Implement", state: "paused" }, { id: "merge", kind: "wait", state: "next" }]
    },
    { expect: ["Will Cory", "Implement"] }
  ),
  failed: story(
    "Failed with a failing required check",
    {
      ...working,
      state: "failed",
      failure: { step: "check", class: "test_failure", message: "Home rejected the limited state", retryable: true },
      steps: [{ id: "check", label: "Check", state: "failed" }, { id: "merge", kind: "wait", state: "next" }],
      run: { id: "run-42", attempt: 2, indicators: [{ tone: "thrash", text: "Home schema failed 3 times" }] },
      evidence: [passed, failedChecks],
      pr
    },
    {
      actions: [
        { tag: "todo.retry", label: "Retry", args: n, primary: true },
        { tag: "todo.retry-current-flow", label: "Retry with the current flow", args: n },
        drop,
        inspect
      ],
      expect: ["Home rejected the limited state", "required-ci", "Home schema failed 3 times"]
    }
  ),
  failed_permanent: story(
    "Failed without retry",
    {
      ...working,
      state: "failed",
      branch: { ...base.branch, machine: { state: "failed", error: { class: "disk_full", message: "Disk full" } } },
      failure: { step: "source", class: "permission_denied", message: "Repository access refused", retryable: false }
    },
    { actions: [drop], expect: ["Repository access refused"] }
  ),
  in_review: story(
    "In review, first in order, checks passed",
    {
      ...working,
      state: "in_review",
      step: "Merge",
      steps: [{ id: "check", label: "Check", state: "done" }, { id: "merge", kind: "wait", state: "held", since: at }],
      pr,
      approval_cleared: true,
      merge: { state: "ready", on_github: false },
      evidence: [passed]
    },
    { actions: [merge, steer], expect: ["required-ci", "Schemas match the spec; fixtures cover every state"] }
  ),
  reviewing: story(
    "Reviewing a new revision, the previous review shown",
    {
      ...working,
      state: "in_review",
      pr,
      merge: { state: "waiting", reason: "rechecking", on_github: false },
      evidence: [{
        attempt: 1,
        revision: "9e8f7a6",
        items: [{ kind: "diff", files: 14, added: 414, removed: 96 }],
        previous: { revision: "4bc79ae", items: passed.items },
        reviewing: true
      }]
    },
    { actions: [steer], expect: ["9e8f7a6", "4bc79ae"] }
  ),
  rebase_pending: story(
    "Rebase pending onto T8",
    {
      ...working,
      state: "in_review",
      steps: [{ id: "check", label: "Check", state: "done" }, { id: "merge", kind: "wait", state: "held", since: at }],
      pr,
      rebase_pending: { onto: "T8" },
      merge: { state: "waiting", reason: "rechecking", on_github: false }
    },
    {
      actions: [{ tag: "branch.rebase-now", label: "Rebase now", args: { branch: "todo/12" }, primary: true }],
      expect: ["T8", "Rebase now"]
    }
  ),
  draft_pr: story(
    "Draft PR that merges after T8",
    {
      ...working,
      state: "in_review",
      pr: { ...pr, draft: true, draft_after: 8, included_items: [8, 12] },
      merge: { state: "waiting", reason: "order", detail: "T8", on_github: false }
    },
    { actions: [{ ...merge, disabled: { reason: "Waiting for T8" } }], expect: ["Waiting for T8"] }
  ),
  blocked_on_github: story(
    "Blocked by a failing required check on GitHub",
    {
      ...working,
      state: "in_review",
      pr,
      evidence: [failedChecks],
      merge: { state: "blocked", reason: "checks", detail: "required-ci", on_github: true }
    },
    { actions: [{ tag: "pr", label: "Open PR", args: { number: "3475" } }], expect: ["required-ci", "Open PR"] }
  ),
  review_required: story(
    "Blocked until a reviewer approves on GitHub",
    {
      ...working,
      state: "in_review",
      pr,
      evidence: [passed],
      merge: { state: "blocked", reason: "review_required", on_github: true }
    },
    { actions: [{ tag: "pr", label: "Open PR", args: { number: "3475" } }], expect: ["Open PR"] }
  ),
  owner_removed: story(
    "Its owner left the team: Take over",
    { ...working, owner_removed: true },
    { actions: [{ tag: "todo.takeover", label: "Take over", args: n, primary: true }], expect: ["Take over"] }
  ),
  missing_tool: story(
    "Failed on a tool the machine image lacks",
    {
      ...working,
      state: "failed",
      failure: {
        step: "check",
        class: "missing_tool",
        message: "ripgrep is not installed",
        retryable: true,
        missing_tool: { name: "ripgrep", file: ".smithers/machine/Brewfile" }
      },
      steps: [{ id: "check", label: "Check", state: "failed" }, { id: "merge", kind: "wait", state: "next" }]
    },
    {
      actions: [{ tag: "todo.retry", label: "Retry", args: n, primary: true }],
      expect: ["ripgrep is not installed", "ripgrep"]
    }
  ),
  merging: story("Merging", { ...working, state: "in_review", pr, merge: { state: "merging", on_github: false } }, {
    expect: ["Card model contracts"]
  }),
  merged: story(
    "Merged in T15's commit",
    {
      ...working,
      state: "merged",
      place: undefined,
      branch: { ...base.branch, machine: { state: "closed" } },
      steps: [{ id: "merge", kind: "wait", state: "done" }],
      pr,
      merged_via: 15,
      merge: { state: "done", on_github: true },
      lessons: 1
    },
    { actions: [inspect], expect: ["Card model contracts"] }
  ),
  dropped: story(
    "Dropped",
    {
      ...base,
      state: "dropped",
      place: undefined,
      queue: undefined,
      branch: { ...base.branch, machine: { state: "closed" } },
      present: []
    },
    { expect: ["Card model contracts"] }
  )
} satisfies Record<string, Story<TodoCard>>
