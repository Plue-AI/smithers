import { PlaceholderAvatarUrl } from "../../src/CardPrimitives.ts"
import type { TimelineCard } from "../../src/TimelineCard.ts"
import { type Story, story } from "./_story.ts"

const lines: TimelineCard["lines"] = [
  {
    entry_id: "entry-10",
    kind: "prompt",
    title: "Publish card contracts",
    tone: "quiet",
    glyph: { actor: { kind: "system", color_index: 7 } }
  },
  {
    entry_id: "entry-11",
    kind: "card",
    title: "T12 Card model contracts",
    summary: "Implementing waits",
    tone: "live",
    glyph: { state: "working" }
  },
  {
    entry_id: "entry-12",
    kind: "card",
    title: "T12 needs you",
    summary: "Include S3 fields?",
    tone: "attention",
    glyph: { state: "needs_you" },
    action: { tag: "todo.answer", label: "Answer", args: { n: "12" } }
  },
  { entry_id: "entry-13", kind: "event", title: "Source ready", tone: "quiet", glyph: { event: "ok" }, fresh: true },
  {
    entry_id: "entry-14",
    kind: "card",
    title: "T9 failed",
    summary: "Checks failed",
    tone: "failed",
    glyph: { state: "failed" },
    action: { tag: "todo.retry", label: "Retry", args: { n: "9" } }
  },
  {
    entry_id: "entry-15",
    kind: "answer",
    title: "T8 merged",
    tone: "done",
    glyph: { actor: { kind: "system", color_index: 7 } }
  }
]

/** A clock reading on one day, in the viewer's zone, so the rendered span reads as written. */
const at = (hour: number, minute: number): number => new Date(2026, 9, 5, hour, minute).getTime()
const smithers = {
  kind: "agent",
  id: "smithers",
  agent: "smithers",
  avatar_url: PlaceholderAvatarUrl,
  color_index: 6
} as const

/**
 * A long chat (an imported Codex session of ~780 entries) as the container folds it (T-UI-08 zoom, #3728): level 3 far
 * above the band, level 2 nearer, level 1 beside it, every entry inside it, then level 1 and 2 below.
 */
const zoomed: TimelineCard["lines"] = [
  {
    entry_id: "entry-1",
    kind: "prompt",
    title: "“Import the Codex session into the app”",
    summary: "6 prompts · 41 answers · 190 steps",
    tone: "done",
    glyph: { event: "ok" },
    zoom: { level: 3, count: 237, last_entry_id: "entry-237", from: at(9, 10), to: at(10, 32) }
  },
  {
    entry_id: "entry-238",
    kind: "prompt",
    title: "“Wire the sign-in button to the GitHub door”",
    summary: "5 prompts · 37 answers · 124 steps · 1 failed",
    tone: "failed",
    glyph: { event: "failed" },
    zoom: { level: 3, count: 166, last_entry_id: "entry-403", from: at(10, 32), to: at(11, 4) }
  },
  {
    entry_id: "entry-404",
    kind: "prompt",
    title: "“Add retry to the webhook sender”",
    summary: "7 prompts · 52 answers · 230 steps",
    tone: "done",
    glyph: { event: "ok" },
    zoom: { level: 3, count: 289, last_entry_id: "entry-692", from: at(11, 4), to: at(11, 40) }
  },
  {
    entry_id: "entry-693",
    kind: "prompt",
    title: "“Why does the retry test hang?”",
    summary: "1 prompt · 4 answers · 19 steps",
    tone: "done",
    glyph: { event: "ok" },
    zoom: { level: 2, count: 24, last_entry_id: "entry-716", from: at(11, 40), to: at(11, 46) }
  },
  {
    entry_id: "entry-717",
    kind: "prompt",
    title: "“Cap the backoff at 30 s”",
    summary: "1 prompt · 3 answers · 12 steps · 1 failed",
    tone: "failed",
    glyph: { event: "failed" },
    zoom: { level: 2, count: 16, last_entry_id: "entry-732", from: at(11, 46), to: at(11, 52) }
  },
  {
    entry_id: "entry-733",
    kind: "prompt",
    title: "“Include the S3 fields?”",
    summary: "1 prompt · 2 answers · 9 steps",
    tone: "attention",
    glyph: { event: "attention" },
    action: { tag: "todo.answer", label: "Answer", args: { n: "12" } },
    zoom: { level: 2, count: 12, last_entry_id: "entry-744", from: at(11, 52), to: at(11, 58) }
  },
  {
    entry_id: "entry-745",
    kind: "prompt",
    title: "“Run the checks again”",
    summary: "1 prompt · 5 steps",
    tone: "done",
    glyph: { event: "ok" },
    zoom: { level: 1, count: 6, last_entry_id: "entry-750", from: at(11, 58), to: at(12, 1) }
  },
  {
    entry_id: "entry-751",
    kind: "answer",
    title: "Checks pass on the second run",
    summary: "1 answer · 3 steps",
    tone: "done",
    glyph: { event: "ok" },
    zoom: { level: 1, count: 4, last_entry_id: "entry-754", from: at(12, 1), to: at(12, 3) }
  },
  {
    entry_id: "entry-755",
    kind: "prompt",
    title: "“Publish card contracts”",
    tone: "quiet",
    glyph: { state: "queued" }
  },
  {
    entry_id: "entry-756",
    kind: "card",
    title: "T12 Card model contracts",
    summary: "Implementing waits",
    tone: "live",
    glyph: { state: "working" }
  },
  { entry_id: "entry-757", kind: "event", title: "Source ready", tone: "quiet", glyph: { event: "ok" }, fresh: true },
  { entry_id: "entry-758", kind: "answer", title: "Contracts published", tone: "quiet", glyph: { actor: smithers } },
  {
    entry_id: "entry-759",
    kind: "prompt",
    title: "“Draft the release notes”",
    summary: "1 prompt · 4 steps",
    tone: "quiet",
    glyph: { event: "ok" },
    zoom: { level: 1, count: 5, last_entry_id: "entry-763", from: at(12, 5), to: at(12, 8) }
  },
  {
    entry_id: "entry-764",
    kind: "prompt",
    title: "“Open the PR”",
    summary: "2 prompts · 3 answers · 9 steps",
    tone: "done",
    glyph: { event: "ok" },
    zoom: { level: 2, count: 14, last_entry_id: "entry-777", from: at(12, 9), to: at(12, 18) }
  }
]

export const fixtures = {
  timeline: story("Every tone, the band on two entries", { lines, on_screen: ["entry-11", "entry-12"] }, {
    expect: ["T12 needs you", "Include S3 fields?", "T9 failed"]
  }),
  one_entry: story("One entry on screen", { lines: lines.slice(0, 1), on_screen: ["entry-10", "entry-10"] }, {
    expect: ["Publish card contracts"]
  }),
  zoomed: story("A long chat zoomed out with distance from the band", {
    lines: zoomed,
    on_screen: ["entry-756", "entry-757"]
  }, {
    expect: [
      "Import the Codex session into the app",
      "237",
      "Include the S3 fields?",
      "12",
      "Cap the backoff at 30 s",
      "Publish card contracts",
      "Open the PR"
    ]
  })
} satisfies Record<string, Story<TimelineCard>>
