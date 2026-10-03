import type { Action } from "../../src/CardAction.ts"
import type { HomeCard, HomeItem, HomeViewState } from "../../src/HomeCard.ts"
import { agent, at, ben, claude_code, person, sha, will, will_person } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const zero = {
  queued: 0,
  starting: 0,
  working: 0,
  needs_you: 0,
  paused: 0,
  failed: 0,
  in_review: 0,
  merged: 0,
  dropped: 0
}
const base: HomeCard = {
  repository: "smithersai/smithers",
  main: { sha, title: "Publish the card contract", last_success_at: at, health: "fresh" },
  attention: [],
  items: [],
  counts: zero,
  merged_since_last_look: [],
  machines: { in_use: 0, capacity: 3, slots: [] },
  background_runs: []
}
const newTodo: Action = {
  tag: "todo.new",
  label: "New TODO",
  input: [{ name: "text", label: "TODO", kind: "text", required: true, multiline: true }]
}
const retrySync: Action = { tag: "github", label: "Retry" }
const menu = (n: number): Action[] => [
  { tag: "stack.move", label: "Move up", args: { n: String(n), direction: "up" } },
  { tag: "stack.move", label: "Move down", args: { n: String(n), direction: "down" } },
  { tag: "todo.drop", label: "Drop", args: { n: String(n) } }
]
const items: HomeItem[] = [
  {
    n: 8,
    title: "Persist merge requests",
    state: "in_review",
    owner: will,
    place: 1,
    merge: { state: "ready", on_github: false },
    approval_cleared: true,
    pr: { number: 3470, draft: false },
    branch: { id: "todo-8", name: "todo/8" },
    present: [will_person],
    amendments: 1,
    actions: [{ tag: "merge", label: "Merge", args: { n: "8" }, primary: true }, ...menu(8)]
  },
  {
    n: 12,
    title: "Card model contracts",
    state: "needs_you",
    owner: ben,
    place: 2,
    step: "Implement",
    rebase_pending: { onto: "T8" },
    needs_you: { kind: "question", prompt: "Include S3 fields?" },
    merge: { state: "waiting", reason: "order", detail: "T8", on_github: false },
    branch: { id: "todo-12", name: "todo/12" },
    present: [person, agent],
    elapsed_s: 142,
    amendments: 0,
    actions: [{
      tag: "todo.answer",
      label: "Answer",
      args: { n: "12" },
      primary: true,
      input: [{ name: "answer", label: "Answer", kind: "text", required: true }]
    }, ...menu(12)]
  },
  {
    n: 15,
    title: "Wire Home",
    state: "working",
    owner: ben,
    place: 3,
    step: "Check",
    merge: { state: "waiting", reason: "state", on_github: false },
    pr: { number: 3480, draft: true },
    branch: { id: "todo-15", name: "todo/15" },
    present: [claude_code],
    elapsed_s: 0.5,
    amendments: 2,
    actions: [{ tag: "todo", label: "Open", args: { n: "15" } }, ...menu(15)]
  },
  {
    n: 16,
    title: "Retry webhook delivery",
    state: "failed",
    owner: will,
    place: 4,
    merge: { state: "blocked", reason: "state", on_github: false },
    branch: { id: "todo-16", name: "todo/16" },
    present: [],
    amendments: 0,
    lessons: 0,
    actions: [{ tag: "todo.retry", label: "Retry", args: { n: "16" }, primary: true }, ...menu(16)]
  },
  {
    n: 17,
    title: "Sweep stale branches",
    state: "queued",
    owner: ben,
    place: 5,
    queue: { reason: "machine", position: 1 },
    merge: { state: "waiting", reason: "state", on_github: false },
    branch: { id: "todo-17", name: "todo/17" },
    present: [],
    amendments: 0,
    actions: [{ tag: "todo", label: "Open", args: { n: "17" }, disabled: { reason: "Waiting for a machine" } }]
  },
  {
    n: 18,
    title: "Refresh the wiki index",
    state: "queued",
    owner: ben,
    place: 6,
    queue: { reason: "daily_limit", position: 1 },
    merge: { state: "waiting", reason: "state", on_github: false },
    branch: { id: "todo-18", name: "todo/18" },
    present: [],
    amendments: 0,
    actions: [{ tag: "todo", label: "Open", args: { n: "18" } }]
  }
]
const activeModel: HomeCard = {
  ...base,
  attention: [
    {
      kind: "order",
      text: "T3 merged before T2",
      todo: 3,
      actions: [{ tag: "order.ok", label: "OK", args: { n: "3" }, primary: true }]
    },
    {
      kind: "force_push",
      text: "Main changed outside Smithers",
      actions: [{ tag: "main.reset-to-github", label: "Reset to GitHub main", args: { revision: sha } }]
    }
  ],
  items,
  counts: { ...zero, queued: 2, working: 1, needs_you: 1, failed: 1, in_review: 1, merged: 4, dropped: 1 },
  merged_since_last_look: [6, 7],
  machines: {
    in_use: 2,
    capacity: 3,
    slots: [
      { branch: "todo/12", actor: agent, awake: true },
      { branch: "todo/15", actor: claude_code, awake: true },
      { branch: "scratch/repro", actor: person, awake: false }
    ]
  },
  parallel: 2,
  background_runs: [
    { id: "review-3470", title: "Review PR #3470", state: "queued", actions: [] },
    { id: "wiki-refresh", title: "Refresh wiki", state: "running", detail: "Reading source", actions: [] },
    { id: "learning-6", title: "Learn from T6", state: "waiting", detail: "Waiting for a machine", actions: [] },
    {
      id: "source-sync",
      title: "Sync source",
      state: "failed",
      detail: "Repository access refused",
      actions: [
        { tag: "background.retry", label: "Retry", args: { id: "source-sync" }, primary: true },
        { tag: "background.dismiss", label: "Dismiss", args: { id: "source-sync" } }
      ]
    }
  ]
}
export const fixtures = {
  fresh: story("Main fresh, empty stack", base, {
    actions: [newTodo],
    view: { maximized: false, on_screen: true },
    expect: ["smithersai/smithers", "Publish the card contract", "New TODO"]
  }),
  stale: story(
    "Main stale",
    { ...base, main: { ...base.main, health: "stale", cause: "GitHub sync delayed" } },
    { actions: [retrySync, newTodo], expect: ["GitHub sync delayed", "Retry"] }
  ),
  limited: story(
    "Main limited, retries later",
    { ...base, main: { ...base.main, health: "limited", cause: "GitHub rate limit", retry_at: "10:42" } },
    { actions: [newTodo], expect: ["GitHub rate limit", "10:42"] }
  ),
  refused: story(
    "Main refused, with Fix",
    { ...base, main: { ...base.main, health: "refused", cause: "Repository access refused" } },
    { actions: [{ tag: "settings", label: "Fix" }], expect: ["Repository access refused", "Fix"] }
  ),
  active: story(
    "A busy stack with attention and background runs",
    activeModel,
    {
      actions: [newTodo],
      expect: [
        "Persist merge requests",
        "Include S3 fields?",
        "T3 merged before T2",
        "Reset to GitHub main",
        "Refresh wiki",
        "Repository access refused"
      ]
    }
  ),
  // §14.5.2: force_push is the owner's to review; a member sees the row without Reset (T-APP-19b, C-UI-12).
  active_member: story(
    "A busy stack as a member sees it",
    {
      ...activeModel,
      attention: activeModel.attention.map((row) => row.kind === "force_push" ? { ...row, actions: [] } : row),
      parallel: undefined
    },
    { actions: [newTodo], expect: ["Main changed outside Smithers"] }
  )
} satisfies Record<string, Story<HomeCard, HomeViewState>>
