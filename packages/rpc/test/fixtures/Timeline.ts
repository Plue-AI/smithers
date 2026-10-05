import type { TimelineCard } from "../../src/TimelineCard.ts"
import { type Story, story } from "./_story.ts"

const lines: TimelineCard["lines"] = [
  { entry_id: "entry-10", kind: "prompt", title: "Publish card contracts", tone: "quiet", glyph: { actor: { kind: "system", color_index: 7 } } },
  {
    entry_id: "entry-11",
    kind: "card",
    title: "T12 Card model contracts",
    summary: "Implementing waits",
    tone: "live", glyph: { state: "working" }
  },
  { entry_id: "entry-12", kind: "card", title: "T12 needs you", summary: "Include S3 fields?", tone: "attention", glyph: { state: "needs_you" }, action: { tag: "todo.answer", label: "Answer", args: { n: "12" } } },
  { entry_id: "entry-13", kind: "event", title: "Source ready", tone: "quiet", glyph: { event: "ok" }, fresh: true },
  { entry_id: "entry-14", kind: "card", title: "T9 failed", summary: "Checks failed", tone: "failed", glyph: { state: "failed" }, action: { tag: "todo.retry", label: "Retry", args: { n: "9" } } },
  { entry_id: "entry-15", kind: "answer", title: "T8 merged", tone: "done", glyph: { actor: { kind: "system", color_index: 7 } } }
]
export const fixtures = {
  timeline: story("Every tone, the band on two entries", { lines, on_screen: ["entry-11", "entry-12"] }, {
    expect: ["T12 needs you", "Include S3 fields?", "T9 failed"]
  }),
  one_entry: story("One entry on screen", { lines: lines.slice(0, 1), on_screen: ["entry-10", "entry-10"] }, {
    expect: ["Publish card contracts"]
  })
} satisfies Record<string, Story<TimelineCard>>
