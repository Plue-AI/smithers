import { createIssuesSeam } from "../seams/IssuesSeam"
import type { Card } from "../AppState"

type IssuePayload = Extract<Card, { kind: "issue" }>["payload"]
import { gatewayBindingFor,resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "../seams/SeamContext"
import { issueAuthorizationScope, readResult } from "../seams/SeamContext"
import type { WorkflowController } from "./workflows"
import type { TodoSeam } from "../seams/TodoSeam"
import { createReviewSeam } from "../seams/ReviewSeam"
import { flowArgs } from "../../flows/FlowArgs"

export interface IssueFlowsController {
  readonly observeReviewConfirmation: ReturnType<typeof createReviewSeam>["observeConfirmation"]
  readonly issueTodoRefusal: (number: number, repo?: string) => Promise<string | undefined>
  readonly inspectIssueFlows: (number: number, repo?: string, humanDoor?: boolean) => Promise<string | { readonly value: string }>
  readonly runIssueFlow: (name: "repro" | "poc", number: number, repo?: string, humanDoor?: boolean) => Promise<string | void | { readonly value: string }>
  readonly runIssueImplementation: (number: number, repo?: string, humanDoor?: boolean) => Promise<string | void | { readonly value: string }>
  /** The host admits review; the browser never runs repository code. */
  readonly triagePullRequest: (number: number, repo?: string, humanDoor?: boolean) => Promise<string | { readonly value: string }>
}

export const createIssueFlowsController = (
  ctx: SeamContext,
  flows: Pick<WorkflowController, "listWorkspaceWorkflows" | "runWorkflow" | "requireBox">,
  todos: Pick<TodoSeam, "draftFromIssue"> & Partial<Pick<TodoSeam, "draftIssueNumber">>,
  backgroundDraft = false
): IssueFlowsController => {
  const authorized = (issue: IssuePayload): boolean => issue.makeTodoAllowed === true
    && /^[0-9a-f]{64}$/.test(issue.issueDigest ?? "")
    && issue.todoAuthorizationScope === issueAuthorizationScope(ctx)
  const reviews = createReviewSeam(ctx)
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
  const issueTodoRefusal: IssueFlowsController["issueTodoRefusal"] = async (number, explicit) => {
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved.error
    const issue = cards().find(card => card.kind === "issue" && card.payload.source === "github" && card.payload.repo === resolved.repo && card.payload.number === number)
    if (backgroundDraft && issue?.kind !== "issue") return undefined // The background read authorizes before writing a private Draft.
    if (issue?.kind !== "issue") return "Open the issue again to check permission to make a TODO."
    const scope = issueAuthorizationScope(ctx)
    const selection = ctx.store.session().activeRepoKey
    const validate = (payload: IssuePayload, digest?: string): string | undefined => {
      if (scope !== issueAuthorizationScope(ctx) || selection !== ctx.store.session().activeRepoKey) return "Open the issue again to check permission to make a TODO."
      if (payload.makeTodoAllowed === false) return "Only a maintainer can make a TODO from this issue."
      if (!authorized(payload) || (digest !== undefined && payload.issueDigest !== digest)) return "Open the issue again to check permission to make a TODO."
      if (payload.state === "closed") return `Issue #${number} is closed.`
      return undefined
    }
    let fresh
    try { fresh = await createIssuesSeam(ctx).readInstallIssue(resolved.repo, number) }
    catch { return "Open the issue again to check permission to make a TODO." }
    if (typeof fresh === "string" || fresh.card.kind !== "issue") return "Open the issue again to check permission to make a TODO."
    const refusal = validate(fresh.card.payload)
    if (refusal !== undefined) return refusal
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: { ...issue, payload: fresh.card.payload } }).isPersisted.promise
    const persistedRefusal = validate(fresh.card.payload)
    if (persistedRefusal !== undefined) return persistedRefusal
    // Browser reads cannot be atomic with server changes; admission at POST /api/todos remains authoritative.
    let latest
    try { latest = await createIssuesSeam(ctx).readInstallIssue(resolved.repo, number) }
    catch { return "Open the issue again to check permission to make a TODO." }
    if (typeof latest === "string" || latest.card.kind !== "issue") return "Open the issue again to check permission to make a TODO."
    return validate(latest.card.payload, fresh.card.payload.issueDigest)
  }
  return {
    issueTodoRefusal,
    inspectIssueFlows,
    // Make TODO: a private Draft of the GitHub issue the card shows, its text
    // and discussion after a current authorized read, committed through POST /api/todos like any Draft. It
    // never launches a workspace flow.
    runIssueImplementation: async (number, explicit) => {
      const resolved = resolveTargetRepo(ctx.store, explicit)
      if ("error" in resolved) return resolved.error
      if (backgroundDraft && todos.draftIssueNumber) return todos.draftIssueNumber(number, resolved.repo)
      const refusal = await issueTodoRefusal(number, explicit)
      if (refusal !== undefined) return refusal
      const issue = cards().find((card): card is Extract<Card, { kind: "issue" }> => card.kind === "issue" && card.payload.source === "github"
        && card.payload.repo === resolved.repo && card.payload.number === number)?.payload
      if (issue === undefined) return `Open GitHub issue #${number} before making a TODO.`
      if (issue.state === "closed") return `Issue #${number} is closed.`
      if (issue.makeTodoAllowed === false) return "Only a maintainer can make a TODO from this issue."
      if (!authorized(issue)) return "Open the issue again to check permission to make a TODO."
      return todos.draftFromIssue({ author: issue.author, number, ...(issue.issueDigest ? { digest: issue.issueDigest } : {}), title: issue.title, body: issue.issueBody, url: issue.htmlUrl ?? `https://github.com/${resolved.repo}/issues/${number}`,
        comments: issue.comments.map(comment => ({ author: comment.author, body: comment.commentBody })) })
    },
    triagePullRequest: reviews.request,
    observeReviewConfirmation: reviews.observeConfirmation,
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
