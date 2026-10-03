import { fixtures } from "@smthrs/rpc/fixtures/Home"
import type { Action } from "@smthrs/rpc/CardAction"
import { HomeView } from "./HomeView"
import type { ViewStory, StoryAction, StoryInteraction } from "./stories"

// Literal oracles: ui-components T-UI-06 / spec §14.3 Home, committed RPC Home fixtures.
const active: StoryAction[] = [
  { tag: "order.ok", label: "OK", args: { n: "3" } },
  { tag: "main.reset-to-github", label: "Reset to GitHub main", args: { revision: "4bc79aef91d66ea28c90b706d584d3b9b48e14ea" } },
  { tag: "merge", label: "Merge", args: { n: "8" } },
  { tag: "todo.answer", label: "Answer", args: { n: "12" } },
  { tag: "todo", label: "Open", args: { n: "15" } },
  { tag: "todo.retry", label: "Retry", args: { n: "16" } },
  { tag: "todo", label: "Open", args: { n: "17" }, disabled: { reason: "Waiting for a machine" } },
  { tag: "todo", label: "Open", args: { n: "18" } },
  { tag: "background.retry", label: "Retry", args: { id: "source-sync" } },
  { tag: "background.dismiss", label: "Dismiss", args: { id: "source-sync" } },
  { tag: "todo.new", label: "New TODO" },
]
const oracles: Record<keyof typeof fixtures, StoryAction[]> = {
  fresh: [{ tag: "todo.new", label: "New TODO" }],
  stale: [{ tag: "github", label: "Retry" }, { tag: "todo.new", label: "New TODO" }],
  limited: [{ tag: "todo.new", label: "New TODO" }],
  refused: [{ tag: "settings", label: "Fix" }],
  active,
  active_member: [active[0]!, ...active.slice(2)],
}
const expected: Record<keyof typeof fixtures, string[]> = {
  fresh: ["Publish the card contract", "0/3 machines"],
  stale: ["GitHub sync delayed", "Retry"],
  limited: ["GitHub rate limit", "retries at 10:42"],
  refused: ["Repository access refused", "Fix"],
  active: ["T3 merged before T2", "Main changed outside Smithers", "Rebase pending onto T8", "Daily limit reached · starts tomorrow", "2 merged since you looked", "2/3 machines", "Review PR #3470", "Refresh wiki", "Learn from T6", "Sync source"],
  active_member: ["Main changed outside Smithers", "2/3 machines"],
}
export const stories: ViewStory[] = (Object.keys(fixtures) as (keyof typeof fixtures)[]).map(key => {
  const fixture = fixtures[key]
  return {
    name: `home-${key}`, expect: expected[key], actions: oracles[key],
    interactions: [
      { selector: '[data-filter="needs_you"]', patch: key.startsWith("active") ? { filter: "needs_you" } : undefined },
      { selector: '[data-filter="working"]', patch: key.startsWith("active") ? { filter: "working" } : undefined },
      { selector: '[data-filter="queued"]', patch: key.startsWith("active") ? { filter: "queued" } : undefined },
      { selector: '[data-filter="in_review"]', patch: key.startsWith("active") ? { filter: "in_review" } : undefined },
      ...(key.startsWith("active") ? [ ["Persist merge requests", "8"], ["Card model contracts", "12"], ["Wire Home", "15"], ["Retry webhook delivery", "16"] ].flatMap(([title, n]): StoryInteraction[] => [
        { selector: `button[aria-label="Order ${title}"]` },
        { selector: '.mvp-menu .mvp-home-action:nth-child(1) button', action: { tag: "stack.move", args: { n: n!, direction: "up" } } },
        { selector: '.mvp-menu .mvp-home-action:nth-child(2) button', action: { tag: "stack.move", args: { n: n!, direction: "down" } } },
        { selector: '.mvp-menu .mvp-home-action:nth-child(3) button', action: { tag: "todo.drop", args: { n: n! } } },
        { selector: `button[aria-label="Order ${title}"]`, event: "keydown" as const, key: "Escape" },
      ]) : []),
    ],
    render: (callbacks, allowed = oracles[key]) => {
      // Only remove the explicitly omitted oracle action; unknown fixture additions stay visible.
      const removed = oracles[key].filter(expected => !allowed.includes(expected))
      const keep = (action: Action) => !removed.some(expected => expected.tag === action.tag && JSON.stringify(expected.args ?? {}) === JSON.stringify(action.args ?? {}))
      return <HomeView {...fixture} {...callbacks} actions={fixture.actions.filter(keep)} model={{ ...fixture.model,
        attention: fixture.model.attention.map(row => ({ ...row, actions: row.actions.filter(keep) })),
        items: fixture.model.items.map(row => ({ ...row, actions: row.actions.filter(keep) })),
        background_runs: fixture.model.background_runs.map(row => ({ ...row, actions: row.actions.filter(keep) })),
      }} />
    },
  }
})

// Independent boundary table: spec §4.1, ui-components Shared types Queue/Merge, T-UI-06.
const boundaryStates = ["queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"] as const
const boundaryQueues = ["machine", "merge_order", "rebase", "daily_limit"] as const
const boundaryMerges = ["ready", "waiting", "blocked", "merging", "done"] as const
stories.push({
  name: "home-boundaries", expect: ["0/0 machines", "Starting", "Paused", "Merged", "Dropped"], actions: [],
  interactions: [
    { selector: '[data-filter="needs_you"]', patch: { filter: "needs_you" } },
    { selector: '[data-filter="working"]', patch: { filter: "working" } },
    { selector: '[data-filter="queued"]', patch: { filter: "queued" } },
    { selector: '[data-filter="in_review"]', patch: { filter: "in_review" } },
  ],
  render: callbacks => <HomeView {...fixtures.fresh} {...callbacks} actions={[]} model={{ ...fixtures.fresh.model,
    machines: { in_use: 0, capacity: 0, slots: [] },
    counts: { queued: 1, starting: 1, working: 1, needs_you: 1, paused: 1, failed: 1, in_review: 1, merged: 1, dropped: 1 },
    items: boundaryStates.map((state, index) => ({ ...fixtures.active.model.items[0]!, n: index + 20, place: index + 1, state,
      title: `T${index + 20}`, present: [], actions: [], approval_cleared: false,
      queue: index < 4 ? { reason: boundaryQueues[index]!, position: index + 1, after: index === 1 ? 8 : undefined } : undefined,
      merge: { state: boundaryMerges[index % 5]!, on_github: false },
    })),
  }} />,
})

// ui-components Shared Merge reason vocabulary; mock captions, independent literals.
const mergeReasons = ["state", "order", "attention", "merging", "rechecking", "pending_work", "stale_head", "checks", "review_required", "github"] as const
stories.push({
  name: "home-merge-reasons",
  expect: ["Not in review yet", "Merges after T8", "Needs you", "Merging", "Checks running", "Pending work", "Rebase pending", "Checks unit", "Review required", "GitHub denied"],
  actions: [],
  interactions: ["needs_you", "working", "queued", "in_review"].map(state => ({ selector: `[data-filter="${state}"]` })),
  render: callbacks => <HomeView {...fixtures.fresh} {...callbacks} actions={[]} model={{ ...fixtures.fresh.model,
    items: mergeReasons.map((reason, index) => ({ ...fixtures.active.model.items[0]!, n: 40 + index, title: `Merge reason ${reason}`, place: index + 1,
      state: "in_review", present: [], actions: [], approval_cleared: false,
      merge: { state: "blocked", reason, detail: reason === "order" ? "T8" : reason === "checks" ? "unit" : reason === "github" ? "denied" : undefined, on_github: false },
    })),
  }} />,
})
