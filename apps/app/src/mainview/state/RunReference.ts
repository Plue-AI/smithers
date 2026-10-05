import type { Card } from "./AppState"
import type { AppStore } from "./AppStore"
import { traceFromJournal } from "../cards/RunTrace"

/** A UI address, not a new backend run ID. A run recorded before every run named its box has no `workspaceId`. */
export interface RunScope {
  readonly repo: string
  readonly runId: string
  readonly workspaceId?: string
}

/** A run address that names its box: the only kind a flow call may use. */
export type BoxRunScope = RunScope & { readonly workspaceId: string }

export const sameRunScope = (left: RunScope, right: RunScope): boolean =>
  left.repo === right.repo && left.runId === right.runId && left.workspaceId === right.workspaceId

/** Only persisted rows (or an actually recorded control child) establish membership. */
export const cardContainsRun = (card: Card, runId: string, allowChild = false): boolean => {
  switch (card.kind) {
    case "run-trace": return card.payload.runId === runId || (allowChild && traceFromJournal({
      runId: card.payload.runId, flowId: card.payload.workflow, status: card.payload.phase
    }, card.payload.events ?? []).rows.some((row) => row.detail.childRunId === runId))
    case "approval": return card.payload.runId === runId
    case "run-list": return card.payload.runs.some((row) => row.runId === runId) ||
      (card.payload.approvals?.some((row) => row.runId === runId) ?? false)
    case "approvals-inbox": return card.payload.approvals.some((row) => row.runId === runId)
    default: return false
  }
}

/** Old ancillary omission can inherit only the already-recorded legacy-key run trace. */
export const runScopeFromCard = (store: AppStore, card: Card, runId: string, requestedWorkspaceId?: string): RunScope | undefined => {
  if (!("repo" in card.payload) || typeof card.payload.repo !== "string") return undefined
  let workspaceId = "workspaceId" in card.payload && typeof card.payload.workspaceId === "string"
    ? card.payload.workspaceId : undefined
  if (card.kind === "run-list") {
    const candidates = card.payload.runs.filter(row => row.runId === runId && (requestedWorkspaceId === undefined || row.workspaceId === requestedWorkspaceId))
    if (requestedWorkspaceId !== undefined && candidates.length === 0) return undefined
    const scopes = new Set(candidates.map(row => row.workspaceId ?? workspaceId))
    if (scopes.size > 1) return undefined
    if (candidates.length > 0) workspaceId = candidates[0]?.workspaceId ?? workspaceId
  }
  if (workspaceId === undefined && card.kind !== "run-trace" && !("gatewayBindingVersion" in card.payload && card.payload.gatewayBindingVersion === 1)) {
    const trace = store.collections.cards.get(`flow-run-${runId}`)
    if (trace?.kind === "run-trace" && trace.payload.runId === runId && trace.payload.repo === card.payload.repo) {
      workspaceId = trace.payload.workspaceId
    }
  }
  return { repo: card.payload.repo, runId, ...(workspaceId === undefined ? {} : { workspaceId }) }
}

export const runCardInScope = (store: AppStore, scope: RunScope): Extract<Card, { kind: "run-trace" }> | undefined =>
  [...store.collections.cards.values()].flatMap((card) =>
    card.kind === "run-trace" && sameRunScope(card.payload, scope) ? [card] : [])
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0]

/** An existing card of this run keeps its address; a new one is qualified by repository, box and run. */
export const runCardIdFor = (store: AppStore, scope: BoxRunScope): string =>
  runCardInScope(store, scope)?.id ?? `flow-run@${scopeKey(scope)}`
const scopeKey = (scope: BoxRunScope): string =>
  [scope.repo, scope.workspaceId, scope.runId].map(encodeURIComponent).join("@")

export const approvalCardIdFor = (store: AppStore, scope: BoxRunScope, requestId: string): string => {
  const existing = [...store.collections.cards.values()].filter((card) => {
    if (card.kind !== "approval" || card.payload.requestId !== requestId || card.payload.runId !== scope.runId) return false
    const recorded = runScopeFromCard(store, card, scope.runId)
    return recorded !== undefined && sameRunScope(recorded, scope)
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0]
  return existing?.id ?? `approval@${scopeKey(scope)}@${encodeURIComponent(requestId)}`
}
