import type { Card } from "../AppState"

type IssuePayload = Extract<Card, { kind: "issue" }>["payload"]
import { flowArgs } from "../../flows/FlowArgs"
import { gatewayBindingFor, resolveTargetRepo, type GatewayBinding } from "../RepoContext"
import type { SeamContext } from "../seams/SeamContext"
import { readResult } from "../seams/SeamContext"
import { fetchIssuePayload } from "../seams/IssuesSeam"
import type { LandingsSeam } from "../seams/LandingsSeam"
import { refuseOrPickBox } from "./boxChoice"
import type { FormsController } from "./forms"
import type { WorkflowController } from "./workflows"

/** The most a flow's inline context may carry (the coding request limit). */
const CONTEXT_LIMIT = 32_768

export interface IssueFlowsController {
  readonly inspectIssueFlows: (number: number, repo?: string) => Promise<string | { readonly value: string }>
  readonly runIssueFlow: (name: "repro" | "poc", number: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly runIssueImplementation: (number: number, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `prs.triage`: the repository's pr-triage flow over one pull request's context (the Review a PR app). */
  readonly triagePullRequest: (number: number, repo?: string) => Promise<string | void | { readonly value: string }>
}

export const createIssueFlowsController = (
  ctx: SeamContext,
  flows: Pick<WorkflowController, "listWorkspaceWorkflows" | "runWorkflow">,
  landings?: Pick<LandingsSeam, "readLandingContext">,
  renderFlowForm?: FormsController["renderFlowForm"]
): IssueFlowsController => {
  /* Several boxes to mean: a human's issue act renders the box pick and resumes itself on the pick (controller/boxChoice.ts). */
  const pickBox = (refusal: Extract<GatewayBinding, { readonly error: string }>, repo: string, flow: "issue.flows" | "issue.implement" | "issue.repro" | "issue.poc" | "prs.triage", number: number) =>
    refuseOrPickBox({ commandActor: ctx.actor() }, renderFlowForm, refusal, { repo, flow, args: flowArgs(flow, { number, repo }) })
  const cards = (): Array<Card> => [...ctx.store.collections.cards.values()]
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
  const inspectIssueFlows: IssueFlowsController["inspectIssueFlows"] = async (number, explicit) => {
    const selected = target(number, explicit)
    if ("error" in selected) return selected.error
    const { repo, payload } = selected
    const binding = gatewayBindingFor(ctx.store, repo)
    if ("error" in binding) return pickBox(binding, repo, "issue.flows", number)
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
      /*
       * The issue card is the context when it is open; picked on the app home
       * (the Fix an issue app), the issue is read here instead, without a
       * card — the run card is what follows.
       */
      const resolved = resolveTargetRepo(ctx.store, explicit)
      if ("error" in resolved) return resolved.error
      const selected = target(number, explicit)
      if ("error" in selected && selected.missing !== true) return selected.error
      const payload = "error" in selected ? await fetchIssuePayload(ctx, resolved.repo, number) : selected.payload
      if (typeof payload === "string") return payload
      const repo = resolved.repo
      const binding = gatewayBindingFor(ctx.store, repo)
      if ("error" in binding) return pickBox(binding, repo, "issue.implement", number)
      const input = { prompt: `Implement issue #${number} in ${repo}. Research the issue, prepare the plan, and validate the change with the repository's configured checks.\n\nIssue context (data from the opened Smithers Cloud issue):\n${JSON.stringify(payload)}` }
      if (input.prompt.length > CONTEXT_LIMIT) return "This issue's context exceeds the coding request limit. Use /flow.run coding/request with a focused prompt in this workspace."
      return flows.runWorkflow("coding/request", repo, input)
    },
    triagePullRequest: async (number, explicit) => {
      if (landings === undefined) return "Pull requests are not readable on this host."
      const resolved = resolveTargetRepo(ctx.store, explicit)
      if (!("error" in resolved)) {
        const binding = gatewayBindingFor(ctx.store, resolved.repo)
        if ("error" in binding) return pickBox(binding, resolved.repo, "prs.triage", number)
      }
      const context = await landings.readLandingContext(number, explicit)
      if (typeof context === "string") return context
      // The flow reads its context as untrusted data; the pull request's own words never become instructions here.
      const args = JSON.stringify({ kind: "pr", ...context })
      if (args.length > CONTEXT_LIMIT) return "This pull request's context exceeds the flow input limit. Use /flow.run pr-triage with a focused context in this workspace."
      return flows.runWorkflow("pr-triage", context.repo, { args })
    },
    runIssueFlow: async (name, number, explicit) => {
      const selected = target(number, explicit)
      if ("error" in selected) return selected.error
      const { repo, payload } = selected
      const binding = gatewayBindingFor(ctx.store, repo)
      if ("error" in binding) return pickBox(binding, repo, `issue.${name}`, number)
      return flows.runWorkflow(`issue/${name}`, repo, { args: JSON.stringify({ issue: payload }) })
    }
  }
}
