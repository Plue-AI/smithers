/**
 * The TODO commands shared by every host that runs them (mvp.md Appendix A): `/stack`, `/todo` and `/todo.new`,
 * with their catalog copy and agent rule, their argument grammar and input, the install routes they call and their
 * answers, the TODO card and the private Draft. The GUI binds its TODO seam to these; the model host binds its
 * host-run commands to the same ones.
 * @since 1.0.0
 */

import { z } from "zod"
import type { AgentCommand } from "./AgentCommands.ts"
import type { Card } from "./Cards.ts"
import type { DraftCard } from "./DraftCard.ts"
import type { TodoCard } from "./TodoCard.ts"

/**
 * `/stack`: the stack and its background runs. The agent reads it at once.
 * @since 1.0.0
 * @category constants
 */
export const STACK_COMMAND = {
  name: "stack",
  summary: "Show the stack and background runs",
  agent: "run"
} as const satisfies AgentCommand

/**
 * `/todo Tn`: one TODO. The agent reads it at once.
 * @since 1.0.0
 * @category constants
 */
export const TODO_COMMAND = {
  name: "todo",
  summary: "Open a TODO",
  args: "<Tn>",
  agent: "run"
} as const satisfies AgentCommand

/**
 * `/todo.new`: writes a TODO. The agent only drafts it: committing a TODO is the person's press (mvp.md Appendix B
 * A✓), so its rule is `confirm`.
 * @since 1.0.0
 * @category constants
 */
export const TODO_NEW_COMMAND = {
  name: "todo.new",
  summary: "Write and place a TODO",
  args: "[text]",
  agent: "confirm"
} as const satisfies AgentCommand

/**
 * `/todo.new`'s declared input. Without `cardId` it opens a Draft with the TODO's text, title, acceptance and place
 * (`before` a TODO, else appended); with a Draft's `cardId` it commits that Draft. `idempotencyKey` is the Commit's.
 * The GUI declares the same fields as its flow input (apps/app flows/entries/todo.ts); its parity test decodes both.
 * @since 1.0.0
 * @category schemas
 */
export const TodoNewInputSchema = z.object({
  text: z.string().optional(),
  title: z.string().min(1).optional(),
  acceptance: z.array(z.string()).optional(),
  before: z.number().int().positive().optional(),
  cardId: z.string().optional(),
  idempotencyKey: z.string().min(1).optional()
})

/**
 * The install's route for the stack's TODOs (spec §6.3): GET lists them, POST files one.
 * @since 1.0.0
 * @category constants
 */
export const TODOS_PATH = "/api/todos"

/**
 * The install's route for one TODO by number.
 * @since 1.0.0
 * @category constructors
 */
export const todoPath = (n: number): string => `${TODOS_PATH}/${n}`

/**
 * What a TODO command's argument text decodes to: its payload, or why it does not parse.
 * @since 1.0.0
 * @category models
 */
export type TodoArgs = { readonly payload: Record<string, unknown> } | { readonly error: string }

/**
 * The TODO commands' argument grammar. JSON is lossless for button and form doors; slash text names a TODO as `T12`
 * or `12`, followed by `field`'s text. With `target` false the whole line is the `text` field. Partial input keeps
 * the TODO number, so a form asks for the rest.
 * @since 1.0.0
 * @category parsers
 */
export const parseTodoArgs = (field?: "text" | "answer", target = true) => (args: string | undefined): TodoArgs => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(line)
      return value && typeof value === "object" && !Array.isArray(value)
        ? { payload: value as Record<string, unknown> }
        : { error: "Invalid TODO input" }
    } catch {
      return { error: "Invalid TODO input" }
    }
  }
  if (!target) return { payload: line ? { text: line } : {} }
  const match = /^(?:T)?([1-9]\d*)(?:\s+([\s\S]*))?$/.exec(line)
  return { payload: match ? { n: Number(match[1]), ...(field && match[2] ? { [field]: match[2] } : {}) } : {} }
}

/**
 * A TODO card.
 * @since 1.0.0
 * @category models
 */
export type TodoEntry = Extract<Card, { readonly kind: "todo" }>

/**
 * A Draft card.
 * @since 1.0.0
 * @category models
 */
export type DraftEntry = Extract<Card, { readonly kind: "draft" }>

/**
 * The TODO card for TODO `n`: its model once read, else a card titled by its number until the model arrives.
 * @since 1.0.0
 * @category constructors
 */
export const todoCard = (n: number, model: TodoCard | undefined, ordinal: number, createdAt: number): TodoEntry => ({
  id: `todo:${n}`,
  kind: "todo",
  title: model?.title ?? `T${n}`,
  status: "active",
  createdAt,
  ordinal,
  payload: { n, ...(model === undefined ? {} : { model }), requests: [] }
})

/**
 * What a Draft starts from: the person it is private to, the TODO's text and where it would go. `id` is the
 * conversation entry that holds it and `idempotencyKey` the key its Commit files the TODO with.
 * @since 1.0.0
 * @category models
 */
export interface DraftSeed {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly title?: string | undefined
  readonly acceptance?: ReadonlyArray<string> | undefined
  readonly before?: number | undefined
  readonly options: DraftCard["place"]["options"]
  readonly idempotencyKey: string
}

/**
 * The private Draft a written TODO starts as (spec §14.3): only its author sees it, and nothing is filed until they
 * press Commit. The title defaults to the text's first line.
 * @since 1.0.0
 * @category constructors
 */
export const draftCard = (seed: DraftSeed, ordinal: number, createdAt: number): DraftEntry => {
  const title = seed.title ?? seed.text.split("\n")[0]!
  const options = [...seed.options]
  return {
    id: seed.id,
    kind: "draft",
    audience_member_id: seed.author,
    title,
    status: "active",
    createdAt,
    ordinal,
    payload: {
      title,
      prompt: seed.text,
      acceptance: [...seed.acceptance ?? []],
      place: seed.before ? { mode: "before", n: seed.before, options } : { mode: "append", options },
      private: true,
      idempotencyKey: seed.idempotencyKey
    }
  }
}
