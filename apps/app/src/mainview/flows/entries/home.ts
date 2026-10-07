/*
 * The Home card's own flows (T-APP-01): `/stack` (the card), reorder, merge,
 * background runs and main's sync retry. Reorder and merge go through the TODO seam: the seeded design
 * world where this host has no TODO provider, else POST /api/todos/{n} {op: move} and
 * /api/todos/{n}/merge (spec §6.3). Background controls use the install’s stored, pinned admission;
 * the seeded design world remains the fallback off an install.
 * Sync Retry calls the real door where
 * this host serves one: the install's POST /api/github/sync (GitHubSyncSeam), or the Cloud's `github.reconcile` (GitHubSeam).
 */
import { Schema } from "effect"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
/* The catalog entry the model host binds its `stack` command to as well (@smthrs/rpc/TodoCommands). */
import { STACK_COMMAND } from "@smthrs/rpc/TodoCommands"
import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { designTodoByNumber, openDesignHome } from "../../state/seams/DesignWorld/home"
import { canMerge, mergeReadiness, type DesignResult } from "../../state/seams/DesignWorld"
import { mergeCard } from "../../state/seams/DesignWorld/chat"

/**
 * Agents never approve, merge or move `main` (AGENTS.md; mvp.md M-05, Appendix B A✓): an agent's Merge
 * opens the person's Review & merge card. A Merge bound to a reviewed head merges, so from an agent it
 * only asks the person, whose press opens that same card.
 */
export const MERGE_CONFIRM_LABEL = "Review & merge"

/** A seed result as the flow layer reads it: an ack value, or the refusal sentence. */
const result = (outcome: DesignResult): { readonly value: string } | string => outcome.ok ? { value: outcome.ack } : outcome.refusal

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
  flow({ name: "stack",   slash: "/stack", cli: ["stack"], journey: ["J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/stack"}, summary: STACK_COMMAND.summary, agent: "run", input: NoPayload,
    handler: () => result(openDesignHome(actions.design, actions.design.viewer())) }),
  flow({ name: "stack.move",   slash: "/stack.move", cli: ["stack","move"], journey: ["J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/todos/{n}",defaults:{op:"move"}}, summary: "Reorder an item", args: "<Tn> <up|down>", hidden: true, grammar: todoGrammar("direction"),
    agent: "run", input: Schema.Struct({ n: N, direction: Schema.Literals(["up", "down"]) }),
    handler: ({ n, direction }) => actions.moveTodo(n, direction) }),
  flow({ name: "merge",   slash: "/merge", cli: ["merge"], journey: ["J1","J2","J4"], group: "TODOs and the stack", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "maintainer", http: {"method":"POST","path":"/api/todos/{n}/merge","body":{"reviewed_head_sha":"reviewed_head_sha"}}, summary: "Review and merge the next item", args: "<Tn>", grammar: todoGrammar(),
    agent: "confirm", input: Schema.Struct({ n: N, reviewed_head_sha: Schema.optional(Schema.String), idempotencyKey: Schema.optional(Schema.String) }),
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
  flow({ name: "background.retry", http: { method: "POST", path: "/api/runs/{id}", defaults: { op: "retry" } }, agent: "run", minimumRole: "member", actors: ["person","app_agent"], visibility: "in-card",  summary: "Retry a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: ({ id }) => actions.backgroundRun(id, "retry") }),
  flow({ name: "background.dismiss", http: { method: "POST", path: "/api/runs/{id}", defaults: { op: "dismiss" } }, agent: "run", minimumRole: "member", actors: ["person","app_agent"], visibility: "in-card",  summary: "Dismiss a background run", args: "<id>", hidden: true, grammar: idGrammar,
    input: Schema.Struct({ id: Id }),
    handler: ({ id }) => actions.backgroundRun(id, "dismiss") }),
  flow({ name: "github", slash: "/github", cli: ["github"], journey: ["J10"], group: "GitHub", visibility: "core",
    actors: ["person", "app_agent", "external_agent"], minimumRole: "member",
    http: { method: "GET", path: "/api/github/sync", query: {} }, summary: "Show sync status and retry", agent: "run",
    grammar: args => {
      if (!args?.trim()) return { payload: {} }
      try { const payload: unknown = JSON.parse(args); return payload && typeof payload === "object" && !Array.isArray(payload)
        ? { payload: payload as Record<string, unknown> } : { error: "Enter a JSON object" } } catch { return { error: "Enter a JSON object" } }
    },
    input: Schema.Struct({ operation: Schema.optional(Schema.Literals(["retry", "app-open", "app-choose", "reconcile", "app-status"])),
      repo: Schema.optional(Schema.String), installationId: Schema.optional(Schema.String) }),
    form: { args: input => JSON.stringify(input), requires: input => input.operation === "app-choose" ? ["installationId"] : [],
      fields: { operation: { hidden: true }, installationId: { label: "Installation", kind: "select" } } },
    preflight: (input, actor) => {
      if (!input.operation || input.operation === "retry" || input.operation === "app-status") return
      if (actor !== "user") return "Only a person can change the GitHub App"
      return actions.snapshot().viewerRole === "owner" ? undefined : "Owner required"
    },
    handler: async input => {
      switch (input.operation) {
        case "app-open": return actions.githubOpenInstall(input.repo)
        case "app-choose": return actions.githubChooseInstallation(Schema.decodeUnknownSync(Schema.String)(input.installationId))
        case "app-status": return actions.githubApp(input.repo)
        case "reconcile": return actions.githubReconcile(input.repo)
        case "retry": return await actions.retryGitHubSync() ?? (actions.bootstrap !== undefined && hasCapability(actions.bootstrap, "cloud")
          ? actions.githubReconcile() : result(actions.design.syncRetry()))
        default: return result(openDesignHome(actions.design, actions.design.viewer()))
      }
    }
  })
]
