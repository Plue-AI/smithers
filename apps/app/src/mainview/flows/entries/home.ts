/*
 * The Home card's own flows (T-APP-01): `/stack` (the card), reorder, merge,
 * background runs and main's sync retry. MOCK SEAM: each handler acts on the seeded design world
 * (state/seams/DesignWorld/home.ts); the real handlers POST
 * /api/todos/{n}/move, /api/todos/{n}/merge, /api/runs/{id} and
 * /api/github/sync (spec §6.3). Sync Retry already calls the real door where this host serves one
 * (`github.reconcile`, GitHubSeam); the install's T-GH-07 `/api/github/sync` has no app seam yet.
 */
import { Schema } from "effect"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
/* The catalog entry the model host binds its `stack` command to as well (@smthrs/rpc/TodoCommands). */
import { STACK_COMMAND } from "@smthrs/rpc/TodoCommands"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { designTodoByNumber, openDesignHome } from "../../state/seams/DesignWorld/home"
import { canMerge, mergeReadiness, type DesignResult, type DesignWorld } from "../../state/seams/DesignWorld"
import { mergeCard } from "../../state/seams/DesignWorld/chat"

/**
 * Agents never approve, merge or move `main` (AGENTS.md; mvp.md M-05, Appendix B A✓): an agent's Merge
 * opens the person's Review & merge card. A Merge bound to a reviewed head merges, so from an agent it
 * only asks the person, whose press opens that same card.
 */
export const MERGE_CONFIRM_LABEL = "Review & merge"

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
  flow({ name: "stack", summary: STACK_COMMAND.summary, input: NoPayload,
    handler: () => result(openDesignHome(actions.design, actions.design.viewer())) }),
  flow({ name: "stack.move", summary: "Reorder an item", args: "<Tn> <up|down>", hidden: true, grammar: todoGrammar("direction"),
    input: Schema.Struct({ n: N, direction: Schema.Literals(["up", "down"]) }),
    handler: ({ n, direction }) => onTodo(actions.design, n, id => actions.design.move(id, direction, actions.design.viewer())) }),
  flow({ name: "merge", summary: "Merge the next item", args: "<Tn>", hidden: true, grammar: todoGrammar(),
    input: Schema.Struct({ n: N, reviewed_head_sha: Schema.optional(Schema.String) }),
    /* The agent's door: a bare Merge runs (it only opens Review & merge); a head-bound one asks the person, whose press opens it. */
    confirm: payload => payload.reviewed_head_sha === undefined ? undefined : MERGE_CONFIRM_LABEL,
    confirmArgs: payload => `T${String(payload.n)}`,
    /* Merge bound to a reviewed head merges; a bare Merge (Home row, /merge Tn, the agent) only opens Review & merge (J4.4). */
    handler: ({ n, reviewed_head_sha }) => {
      /* The TODO seam picks the seed or this host's /api/todos/{n}/merge. */
      if (reviewed_head_sha !== undefined) return actions.mergeTodo(n, reviewed_head_sha)
      /* A bare Merge opens the person's Review & merge: the seed's, or this host's TODO read from /api/todos/{n}. */
      return actions.todoRoute(n, ["merge"], async () => {
        const design = actions.design
        const viewer = design.viewer()
        const world = design.world()
        const todo = designTodoByNumber(world, n)
        if (todo === undefined) return `No TODO T${n}`
        if (!canMerge(world, viewer)) return "A maintainer merges"
        const readiness = mergeReadiness(world, todo)
        if (readiness.state === "done") return `${todo.ref} already merged`
        if (readiness.state !== "ready") return readiness.reason
        return { value: await actions.presentSubject(mergeCard(todo, viewer)) }
      }, () => actions.reviewTodoMerge(n))
    } }),
  flow({ name: "background.retry", summary: "Retry a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: ({ id }) => result(actions.design.retryRun(id)) }),
  flow({ name: "background.dismiss", summary: "Dismiss a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: ({ id }) => result(actions.design.dismissRun(id)) }),
  flow({ name: "github", summary: "Show sync status", input: NoPayload,
    handler: () => result(openDesignHome(actions.design, actions.design.viewer())) }),
  flow({ name: "github.retry", summary: "Retry GitHub sync", hidden: true, input: NoPayload,
    /* The real sync door where this host serves it (GitHubSeam `github.reconcile`); MOCK SEAM: the seed's sync otherwise. */
    handler: () => actions.bootstrap !== undefined && hasCapability(actions.bootstrap, "cloud")
      ? actions.githubReconcile()
      : result(actions.design.syncRetry()) })
]
