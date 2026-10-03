import type { EntryRowCard } from "../../src/EntryRowCard.ts"
import { agent, claude_code, person, smithers_for_ben, system } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const base: EntryRowCard = { kind: "prompt", author: person, title: "Card model contracts", tone: "quiet" }
export const fixtures = {
  prompt: story("A prompt", base, { expect: ["Card model contracts"] }),
  tombstone: story(
    "A tombstone: the card title only",
    { ...base, kind: "card", author: agent, summary: "Ignored", tone: "quiet", tombstone: true },
    { expect: ["Card model contracts"] }
  ),
  answer: story(
    "Smithers answers with context",
    {
      ...base,
      kind: "answer",
      author: smithers_for_ben,
      title: "TODO cards list every open wait",
      summary: "Read TodoCard.ts and the spec",
      context: {
        count: 2,
        items: [
          { kind: "file", label: "TodoCard.ts", ref: "packages/rpc/src/TodoCard.ts", revision: "4bc79ae" },
          { kind: "page", label: "Factory decisions", ref: "wiki/factory-decisions" }
        ]
      }
    },
    { expect: ["TODO cards list every open wait", "Read TodoCard.ts and the spec"] }
  ),
  working: story(
    "A working TODO card",
    {
      ...base,
      kind: "card",
      author: agent,
      summary: "Added typed TODO fields",
      tone: "live",
      state: "working",
      context: { count: 1, items: [{ kind: "file", label: "TodoCard.ts", ref: "packages/rpc/src/TodoCard.ts" }] }
    },
    { expect: ["Card model contracts", "Added typed TODO fields"] }
  ),
  needs_you: story(
    "Needs you, with Answer",
    {
      ...base,
      kind: "card",
      author: agent,
      tone: "attention",
      state: "needs_you",
      action: {
        tag: "todo.answer",
        label: "Answer",
        args: { n: "12" },
        input: [{ name: "answer", label: "Answer", kind: "text", required: true }, {
          name: "model",
          label: "Model",
          kind: "choice",
          choices: ["gpt-6.1-sol", "gpt-6-astra"],
          required: false
        }, { name: "token", label: "Token", kind: "secret", required: true }]
      }
    },
    { expect: ["Card model contracts", "Answer"] }
  ),
  in_review: story(
    "In review, with Merge",
    {
      ...base,
      kind: "card",
      author: agent,
      tone: "attention",
      state: "in_review",
      action: { tag: "merge", label: "Merge", args: { n: "12" }, primary: true }
    },
    { expect: ["Merge"] }
  ),
  failed: story(
    "Failed, Retry disabled",
    {
      ...base,
      kind: "card",
      author: claude_code,
      tone: "failed",
      state: "failed",
      action: {
        tag: "todo.retry",
        label: "Retry",
        args: { n: "12" },
        disabled: { reason: "Repository access refused" }
      }
    },
    { expect: ["Retry", "Repository access refused"] }
  ),
  event: story("A system event", { ...base, kind: "event", author: system, title: "Source ready" }, {
    expect: ["Source ready"]
  }),
  done: story("A merged TODO", { ...base, kind: "card", tone: "done", state: "merged" }, {
    expect: ["Card model contracts"]
  }),
  private: story("A private Draft", { ...base, kind: "card", title: "Drop T12", private: true }, {
    expect: ["Drop T12"]
  })
} satisfies Record<string, Story<EntryRowCard>>
