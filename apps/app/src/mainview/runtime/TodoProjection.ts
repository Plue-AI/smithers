import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"

/** The source transaction records its card beside the existing TODO fact. */
export function projectTodoCard(previous: unknown, delta: unknown): TodoCard {
  const before = TodoCardSchema.parse(previous)
  const event = delta as { Type?: unknown; State?: unknown; Data?: { card?: unknown } } | undefined
  if (typeof event?.Type !== "string" || !event.Type.startsWith("todo.")) throw new Error("Invalid TODO source fact")
  const card = TodoCardSchema.parse(event.Data?.card)
  if (card.n !== before.n || card.state !== event.State) throw new Error("TODO source card mismatch")
  return card
}
