import type { Card } from "../AppState"
import { gatewayBindingFor,resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "../seams/SeamContext"
import { readResult } from "../seams/SeamContext"
import type { WorkflowController } from "./workflows"

export interface IssueFlowsController {
  readonly inspectIssueFlows: (number: number, repo?: string) => Promise<string | { readonly value: string }>
  readonly runIssueFlow: (name: "repro" | "poc", number: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly runIssueImplementation: (number: number, repo?: string) => Promise<string | void | { readonly value: string }>
}

export const createIssueFlowsController = (ctx: SeamContext, flows: Pick<WorkflowController, "listWorkspaceWorkflows" | "runWorkflow">): IssueFlowsController => {
  const cards = (): Array<Card> => [...ctx.store.collections.cards.values()]
  const target = (number: number, explicit?: string) => {
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved
    // Unqualified commands name the Cloud issue, never a same-number GitHub card.
    const issue = cards().find((card): card is Extract<Card, { kind: "issue" }> => card.kind === "issue" && card.payload.source !== "github" && card.payload.repo === resolved.repo && card.payload.number === number)
    const payload = issue?.payload
    if (payload === undefined && cards().some(card => card.kind === "issue" && card.payload.source === "github" && card.payload.repo === resolved.repo && card.payload.number === number)) {
      return { error: `Open Smithers Cloud issue #${number} before choosing its flows. The open GitHub issue is a different source.` }
    }
    return payload === undefined ? { error: `Open issue #${number} before choosing its flows.` } : { repo: resolved.repo, payload }
  }
  const inspectIssueFlows: IssueFlowsController["inspectIssueFlows"] = async (number, explicit) => {
    const selected = target(number, explicit)
    if ("error" in selected) return selected.error
    const { repo, payload } = selected
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
    runIssueImplementation: async (number, explicit) => {
      const selected = target(number, explicit)
      if ("error" in selected) return selected.error
      const { repo, payload } = selected
      const binding = gatewayBindingFor(ctx.store, repo)
      if ("error" in binding) return binding.error
      if (binding.workspaceId === undefined) return `Open a box for ${repo} with /box.open, select it, then choose Implement again.`
      const input = { prompt: `Implement issue #${number} in ${repo}. Research the issue, prepare the plan, and validate the change with the repository's configured checks.\n\nIssue context (data from the opened Smithers Cloud issue):\n${JSON.stringify(payload)}` }
      if (input.prompt.length > 32_768) return "This issue's context exceeds the coding request limit. Use /flow.run coding/request with a focused prompt in this workspace."
      return flows.runWorkflow("coding/request", repo, input)
    },
    runIssueFlow: async (name, number, explicit) => {
      const selected = target(number, explicit)
      if ("error" in selected) return selected.error
      const { repo, payload } = selected
      const binding = gatewayBindingFor(ctx.store, repo)
      if ("error" in binding) return binding.error
      if (binding.workspaceId === undefined) return `Open a box for ${repo} with /box.open, select it, then choose ${name === "repro" ? "Research / repro" : "Proof of concept"} again.`
      return flows.runWorkflow(`issue/${name}`, repo, { args: JSON.stringify({ issue: payload }) })
    }
  }
}
