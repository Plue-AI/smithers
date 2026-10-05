/**
 * The TODO commands shared by every host that runs them (mvp.md Appendix A): `/stack`, `/todo` and `/todo.new`,
 * with their catalog copy, their argument grammar, the install routes they call and their answers, the TODO card
 * and the private Draft. The GUI binds its TODO seam to these; the model host binds its host-run commands to the
 * same ones.
 * @since 1.0.0
 */

import type { Card } from "./Cards.ts"
import type { DraftCard } from "./DraftCard.ts"
import type { TodoCard } from "./TodoCard.ts"

/**
 * The stack's name, as the catalog and the conversation name it.
 * @since 1.0.0
 * @category constants
 */
export const STACK = "stack"

/**
 * The stack's catalog copy.
 * @since 1.0.0
 * @category constants
 */
export const STACK_COPY = { summary: "Show the stack and background runs" } as const

/**
 * The name of the command that opens one TODO.
 * @since 1.0.0
 * @category constants
 */
export const TODO = "todo"

/**
 * The catalog copy of the command that opens one TODO.
 * @since 1.0.0
 * @category constants
 */
export const TODO_COPY = { summary: "Open a TODO", args: "<Tn>" } as const

/**
 * The name of the command that writes a TODO.
 * @since 1.0.0
 * @category constants
 */
export const TODO_NEW = "todo.new"

/**
 * The catalog copy of the command that writes a TODO.
 * @since 1.0.0
 * @category constants
 */
export const TODO_NEW_COPY = { summary: "Write and place a TODO", args: "[text]" } as const

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
