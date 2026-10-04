/*
 * The Home card's own flows (T-APP-01): `/stack` (the card), reorder, merge,
 * background runs and main's sync retry. MOCK SEAM: each handler acts on the seeded design world
 * (state/seams/DesignWorld/home.ts); the real handlers POST
 * /api/todos/{n}/move, /api/todos/{n}/merge, /api/runs/{id} and
 * /api/github/sync (spec §6.3).
 */
import { Schema } from "effect"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { designTodoByNumber, openDesignHome } from "../../state/seams/DesignWorld/home"
import { canMerge, mergeReadiness, type DesignResult, type DesignWorld } from "../../state/seams/DesignWorld"
import { mergeCard } from "../../state/seams/DesignWorld/chat"

/** Agents never approve, merge or move `main` (AGENTS.md; mvp.md M-05): an agent's Merge is the person's Review card. */
export const MERGE_USER_ONLY_REASON = "a person merges; an agent's Merge opens the Review card"

/** A seed result as the flow layer reads it: an ack value, or the refusal sentence. */
const result = (outcome: DesignResult): { readonly value: string } | string => outcome.ok ? { value: outcome.ack } : outcome.refusal
const onTodo = (design: DesignWorld, n: number, act: (id: string) => DesignResult) => {
  const todo = designTodoByNumber(design.world(), n)
  return todo === undefined ? `No TODO T${n}` : result(act(todo.id))
}

const N = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Id = Schema.String.check(Schema.isMinLength(1))
/** JSON for button doors; `T12 up` or `12` for the slash door. */
const todoGrammar = (field?: "direction"): Grammar => args => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(line)
      return value && typeof value === "object" && !Array.isArray(value) ? { payload: value as Record<string, unknown> } : { error: "Invalid input" }
    } catch { return { error: "Invalid input" } }
  }
  const match = /^(?:T)?([1-9]\d*)(?:\s+(\S+))?$/.exec(line)
  return { payload: match ? { n: Number(match[1]), ...(field && match[2] ? { [field]: match[2] } : {}) } : {} }
}
const idGrammar: Grammar = args => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try { return { payload: JSON.parse(line) as Record<string, unknown> } } catch { return { error: "Invalid input" } }
  }
  return { payload: line ? { id: line } : {} }
}

export const homeFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "stack", summary: "Show the stack and background runs", input: NoPayload,
    handler: () => result(openDesignHome(actions.design, actions.design.viewer())) }),
  flow({ name: "stack.move", summary: "Reorder an item", args: "<Tn> <up|down>", hidden: true, grammar: todoGrammar("direction"),
    input: Schema.Struct({ n: N, direction: Schema.Literals(["up", "down"]) }),
    handler: ({ n, direction }) => onTodo(actions.design, n, id => actions.design.move(id, direction, actions.design.viewer())) }),
  flow({ name: "merge", summary: "Merge the next item", args: "<Tn>", hidden: true, userOnly: true, userOnlyReason: MERGE_USER_ONLY_REASON, grammar: todoGrammar(),
    input: Schema.Struct({ n: N, reviewed_head_sha: Schema.optional(Schema.String) }),
    /* Merge bound to a reviewed head merges; a bare Merge (Home row, /merge Tn) first opens Review & merge (J4.4). */
    handler: async ({ n, reviewed_head_sha }) => {
      const design = actions.design
      const viewer = design.viewer()
      const todo = designTodoByNumber(design.world(), n)
      if (reviewed_head_sha !== undefined || todo === undefined || !canMerge(design.world(), viewer) || mergeReadiness(design.world(), todo).state !== "ready")
        return onTodo(design, n, id => design.merge(id, viewer, reviewed_head_sha))
      return { value: await actions.presentSubject(mergeCard(todo, viewer)) }
    } }),
  flow({ name: "background.retry", summary: "Retry a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: ({ id }) => result(actions.design.retryRun(id)) }),
  flow({ name: "background.dismiss", summary: "Dismiss a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: ({ id }) => result(actions.design.dismissRun(id)) }),
  flow({ name: "github", summary: "Show sync status and retry", hidden: true, input: NoPayload,
    handler: () => result(actions.design.syncRetry()) })
]
