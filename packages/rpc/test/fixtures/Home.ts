import type { HomeCard } from "../../src/HomeCard.ts"
import { at, ben, person, sha, will } from "./_shared.ts"

const base: HomeCard = {
  repository: "smithersai/smithers",
  main: { sha, title: "Publish the card contract", last_success_at: at, health: "fresh" },
  attention: [],
  items: [],
  counts: {
    queued: 0,
    starting: 0,
    working: 0,
    needs_you: 0,
    paused: 0,
    failed: 0,
    in_review: 0,
    merged: 0,
    dropped: 0
  },
  merged_since_last_look: [],
  machines: { in_use: 0, capacity: 3, slots: [] },
  background_runs: []
}
export const fixtures = {
  fresh: base,
  stale: {
    ...base,
    main: { ...base.main, health: "stale", cause: "GitHub sync delayed", retry_at: "2026-10-02T17:43:00.000Z" }
  },
  refused: { ...base, main: { ...base.main, health: "refused", cause: "Repository access refused" } },
  limited: {
    ...base,
    main: { ...base.main, health: "limited", cause: "GitHub rate limit", retry_at: "2026-10-02T18:00:00.000Z" }
  },
  active: {
    ...base,
    machines: { in_use: 2, capacity: 3, slots: [] },
    counts: {
      queued: 1,
      starting: 1,
      working: 1,
      needs_you: 1,
      paused: 1,
      failed: 1,
      in_review: 1,
      merged: 1,
      dropped: 1
    },
    items: [
      {
        n: 8,
        title: "Persist merge requests",
        state: "in_review",
        place: 1,
        amendments: 1,
        branch: { id: "todo-8", name: "todo/8", machine: "ready" },
        merge: { state: "ready", on_github: false },
        present: [person],
        elapsed_s: 348,
        pr: { number: 3470, draft: false },
        approval_cleared: true,
        actions: [{ tag: "merge", label: "Merge", primary: true }]
      },
      {
        n: 12,
        title: "Card model contracts",
        state: "needs_you",
        place: 2,
        step: "implement",
        needs_you: { kind: "question" },
        rebase_pending: { onto: "T8" },
        merge: { state: "waiting", reason: "order", detail: "T8", on_github: false },
        amendments: 0,
        branch: { id: "todo-12", name: "todo/12", machine: "ready" },
        present: [person, { ...person, ...will }],
        elapsed_s: 142,
        actions: [{
          tag: "todo.answer",
          label: "Answer",
          primary: true,
          input: [{ name: "answer", label: "Answer", kind: "text", required: true }]
        }]
      },
      {
        n: 15,
        title: "Wire Home",
        state: "queued",
        place: 3,
        queue: { reason: "machine", position: 1 },
        amendments: 0,
        branch: { id: "todo-15", name: "todo/15", machine: "waiting" },
        merge: { state: "waiting", reason: "state", on_github: false },
        present: [],
        elapsed_s: 0,
        pr: { number: 3480, draft: true },
        actions: [{ tag: "todo", label: "Open", disabled: { reason: "Waiting for T8" } }]
      }
    ],
    attention: [{ kind: "order", text: "Order changed", todo: 12 }, {
      kind: "force_push",
      text: "Main changed outside Smithers"
    }],
    merged_since_last_look: [6],
    background_runs: [{ id: "wiki-refresh", title: "Refresh wiki", state: "running", detail: "Reading source" }, {
      id: "source-sync",
      title: "Sync source",
      state: "failed",
      detail: "Repository access refused"
    }]
  }
} satisfies Record<string, HomeCard>
