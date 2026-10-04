import type { Card } from "../AppState"

type IssuePayload = Extract<Card, { kind: "issue" }>["payload"]
import { gatewayBindingFor,resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "../seams/SeamContext"
import { readResult } from "../seams/SeamContext"
import { fetchIssuePayload } from "../seams/IssuesSeam"
import type { WorkflowController } from "./workflows"
import { flowArgs } from "../../flows/FlowArgs"

/** The most a flow's inline context may carry (the coding request limit). */
const CONTEXT_LIMIT = 32_768

export interface IssueFlowsController {
  readonly inspectIssueFlows: (number: number, repo?: string, humanDoor?: boolean) => Promise<string | { readonly value: string }>
  readonly runIssueFlow: (name: "repro" | "poc", number: number, repo?: string, humanDoor?: boolean) => Promise<string | void | { readonly value: string }>
  readonly runIssueImplementation: (number: number, repo?: string, humanDoor?: boolean) => Promise<string | void | { readonly value: string }>
  /** Review remains dark until the host can authorize and dispatch an isolated run. */
  readonly triagePullRequest: (number: number, repo?: string, humanDoor?: boolean) => Promise<string>
}

export const createIssueFlowsController = (
  ctx: SeamContext,
  flows: Pick<WorkflowController, "listWorkspaceWorkflows" | "runWorkflow" | "requireBox">
): IssueFlowsController => {
  const cards = (): Array<Card> => [...ctx.store.collections.cards.values()]
  const requireBox = (repo: string, flow: string, args: string, title: string, humanDoor: boolean): string | { readonly value: string } | undefined => {
    if (humanDoor) return flows.requireBox(repo, { flow, args }, title)
    const binding = gatewayBindingFor(ctx.store, repo)
    return "error" in binding ? binding.error : undefined
  }
  type Target = { readonly error: string; readonly missing?: true } | { readonly repo: string; readonly payload: IssuePayload }
  const target = (number: number, explicit?: string): Target => {
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved
    // Unqualified commands name the Cloud issue, never a same-number GitHub card.
    const issue = cards().find((card): card is Extract<Card, { kind: "issue" }> => card.kind === "issue" && card.payload.source !== "github" && card.payload.repo === resolved.repo && card.payload.number === number)
    const payload = issue?.payload
    if (payload === undefined && cards().some(card => card.kind === "issue" && card.payload.source === "github" && card.payload.repo === resolved.repo && card.payload.number === number)) {
      return { error: `Open Smithers Cloud issue #${number} before choosing its flows. The open GitHub issue is a different source.` }
    }
    return payload === undefined ? { error: `Open issue #${number} before choosing its flows.`, missing: true as const } : { repo: resolved.repo, payload }
  }
  const inspectIssueFlows: IssueFlowsController["inspectIssueFlows"] = async (number, explicit, humanDoor = false) => {
    const selected = target(number, explicit)
    if ("error" in selected) return selected.error
    const { repo, payload } = selected
    const prerequisite = requireBox(repo, "issue.flows", flowArgs("issue.flows", { number, repo }), `Open a box to see issue #${number}'s flows`, humanDoor)
    if (prerequisite !== undefined) return prerequisite
    const scope = JSON.stringify([ctx.store.session().activeRepoKey, ctx.store.session().activeWorkspaceId, ctx.store.collections.identitySessions.get("identity")?.login, 0])
    const result = await flows.listWorkspaceWorkflows(repo)
    if (typeof result === "string") return result
    if (scope !== JSON.stringify([ctx.store.session().activeRepoKey, ctx.store.session().activeWorkspaceId, ctx.store.collections.identitySessions.get("identity")?.login, 0])) return "The repository changed while loading its issue flows. Open the issue again."
    const source = cards().filter((card): card is Extract<Card, {kind:"workflow-list"}> => card.kind === "workflow-list" && card.payload.repo === repo).sort((a,b) => b.ordinal-a.ordinal)[0]
    if (!source) return "The workspace did not return its flow catalog."
    const catalog: Extract<Card, { kind: "workflow-list" }> = { ...source, title: `Issue #${number} · Flows`, payload: { ...source.payload, issueContext: { number, title: payload.title }, workflows: source.payload.workflows.filter(flow => /^issue[./]/.test(flow.key)) } }
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: catalog }).isPersisted.promise
    return readResult(catalog.payload.workflows.map(flow => `${flow.key}: ${flow.description ?? ""}${flow.prompt ? `\n${flow.prompt}` : ""}`).join("\n") || "No issue flows are installed on this workspace.")
  }
  return {
    inspectIssueFlows,
    runIssueImplementation: async (number, explicit, humanDoor = false) => {
      /*
       * The issue card is the context when it is open; picked on the app home
       * (the Fix an issue app), the issue is read here instead, without a
       * card — the run card is what follows.
       */
      const resolved = resolveTargetRepo(ctx.store, explicit)
      if ("error" in resolved) return resolved.error
      const selected = target(number, explicit)
      if ("error" in selected && selected.missing !== true) return selected.error
      const repo = resolved.repo
      // The human reaches setup before a remote read; direct callers retain
      // the existing issue-read failure before their no-box refusal.
      if (humanDoor) {
        const prerequisite = requireBox(repo, "issue.implement", flowArgs("issue.implement", { number, repo }), `Open a box to implement issue #${number}`, true)
        if (prerequisite !== undefined) return prerequisite
      }
      const payload = "error" in selected ? await fetchIssuePayload(ctx, resolved.repo, number) : selected.payload
      if (typeof payload === "string") return payload
      if (!humanDoor) {
        const prerequisite = requireBox(repo, "issue.implement", flowArgs("issue.implement", { number, repo }), `Open a box to implement issue #${number}`, false)
        if (prerequisite !== undefined) return prerequisite
      }
      const input = { prompt: `Implement issue #${number} in ${repo}. Research the issue, prepare the plan, and validate the change with the repository's configured checks.\n\nIssue context (data from the opened Smithers Cloud issue):\n${JSON.stringify(payload)}` }
      if (input.prompt.length > CONTEXT_LIMIT) return "This issue's context exceeds the coding request limit. Use /flow.run coding/request with a focused prompt in this workspace."
      return flows.runWorkflow("coding/request", repo, input)
    },
    // No browser launch can establish host-bound authorization, membership,
    // confirmation, Active closure, pinned loading, delivery or microVM safety.
    triagePullRequest: async () => "Review is unavailable on this host.",
    runIssueFlow: async (name, number, explicit, humanDoor = false) => {
      const selected = target(number, explicit)
      if ("error" in selected) return selected.error
      const { repo, payload } = selected
      const prerequisite = requireBox(repo, `issue.${name}`, flowArgs(name === "repro" ? "issue.repro" : "issue.poc", { number, repo }), `Open a box to run issue #${number}'s ${name} flow`, humanDoor)
      if (prerequisite !== undefined) return prerequisite
      return flows.runWorkflow(`issue/${name}`, repo, { args: JSON.stringify({ issue: payload }) })
    }
  }
}
