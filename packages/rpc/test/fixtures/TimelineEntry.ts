import type { TimelineEntryCard } from "../../src/TimelineEntryCard.ts"
import { agent, person } from "./_shared.ts"

const base: TimelineEntryCard = {
  kind: "prompt",
  entry_id: "entry-12",
  author: person,
  title: "Card model contracts",
  tone: "quiet",
  state: null
}
export const fixtures = {
  prompt: base,
  working: {
    ...base,
    kind: "answer",
    author: agent,
    summary: "Added typed TODO fields",
    tone: "live",
    state: "working",
    context: { count: 1, items: [{ kind: "file", label: "TodoCard.ts", ref: "packages/rpc/src/TodoCard.ts" }] }
  },
  needs_you: {
    ...base,
    author: agent,
    tone: "attention",
    state: "needs_you",
    action: {
      tag: "todo.answer",
      label: "Answer",
      input: [{ name: "answer", label: "Answer", kind: "text", required: true }, {
        name: "model",
        label: "Model",
        kind: "choice",
        choices: ["gpt-6.1-sol", "gpt-6-astra"],
        required: false
      }, { name: "token", label: "Token", kind: "secret", required: true }]
    }
  },
  failed: {
    ...base,
    tone: "failed",
    state: "failed",
    action: { tag: "todo.retry", label: "Retry", disabled: { reason: "Repository access refused" } }
  },
  card: { ...base, kind: "card" },
  event: { ...base, kind: "event", summary: "Source ready" },
  done: { ...base, tone: "done", state: "merged" },
  private: { ...base, title: "Drop T12", private: true },
  shared: { ...base, private: false }
} satisfies Record<string, TimelineEntryCard>
