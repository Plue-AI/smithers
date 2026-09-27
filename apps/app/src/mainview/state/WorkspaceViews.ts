import { and, BTreeIndex, createLiveQueryCollection, createCollection, eq, isUndefined } from "@tanstack/db"
import { sharedCopyIdOf } from "./AppState"
import type { Card, CloudRepository, CloudWorkspaceInput, CloudWorkspaceRow, WorkingCopy } from "./AppState"
import type { StoredCollections } from "./AppStore"
import { projectRuntimeCard } from "./RuntimeProjection"

/** The workspace row owns header facts; the card owns its loaded facets. */
export const workspaceCardFacts = (workspace: CloudWorkspaceInput) => ({
  workspaceId: workspace.id,
  repo: workspace.repoId,
  name: workspace.name,
  targetBookmark: workspace.targetBookmark,
  status: workspace.status,
  failureCode: workspace.failureCode ?? null,
  failureMessage: workspace.failureMessage ?? null,
  provisioningStage: workspace.provisioningStage,
  suspendedAt: workspace.suspendedAt,
  workspaceKind: workspace.kind ?? null,
  agentSessionId: workspace.agentSessionId ?? null,
  head: workspace.head ?? null,
  ahead: workspace.ahead ?? null,
  behind: workspace.behind ?? null,
  startedAt: workspace.startedAt ?? null,
  environment: workspace.environment ?? null,
  persistence: workspace.persistence ?? null,
  sshHost: workspace.sshHost ?? null,
  desktop: workspace.desktop ?? null,
  lspLanguages: workspace.lspLanguages ?? null
})

export const projectWorkspaceCard = (card: Card, workspace: CloudWorkspaceInput | undefined): Card =>
  card.kind !== "workspace" || card.payload.snapshot === true || workspace === undefined ? card : {
    ...card,
    title: `${workspace.name} · ${workspace.repoId}`,
    payload: { ...card.payload, ...workspaceCardFacts(workspace) }
  }

/** Historical cards retain their captured facts, even when restored into a live branch. */
export const snapshotCard = (card: Card): Card =>
  card.kind === "workspace"
    ? { ...card, payload: { ...card.payload, snapshot: true } }
    : card

const workspaceCopy = (workspace: CloudWorkspaceRow): WorkingCopy => ({
  id: `workspace:${workspace.id}`,
  repoId: workspace.repoId,
  kind: "workspace",
  label: workspace.name,
  ...(workspace.targetBookmark === null ? {} : { bookmark: workspace.targetBookmark }),
  workspaceId: workspace.id,
  state: workspace.status,
  updatedAt: workspace.updatedAt,
  revision: workspace.revision
})

/*
 * The shared copy of a public repository (factory design session ruling,
 * lane plan B2: read-only users share one virtual box over the public
 * mirror; no VM, no terminal; factory spec 04 §2 keeps one box per branch
 * per signed-in person).
 * One per catalog row, derived and never stored: it exists exactly while
 * the public catalog (GET /api/public/repos) lists the repository and no
 * box of the visitor's own stands on it (a person with a box is not a
 * read-only user of that repository). Its bookmark is the row's head
 * bookmark when a seam supplied one; the catalog itself carries no head, so
 * the label does not invent it.
 */
export const sharedCopyOf = (repository: Pick<CloudRepository, "id" | "head" | "updatedAt" | "revision">): WorkingCopy => ({
  id: sharedCopyIdOf(repository.id),
  repoId: repository.id,
  kind: "shared",
  access: "read",
  ...(repository.head === null ? {} : { bookmark: repository.head.bookmark }),
  label: "shared",
  updatedAt: repository.updatedAt,
  revision: repository.revision
})

/** A copy no door may write through: today the shared copy, whose only route is the mirror's contents read. */
export const isReadOnlyCopy = (copy: Pick<WorkingCopy, "access">): boolean => copy.access === "read"

/**
 * The sidebar's line for a copy: what the seams hold and nothing more. A
 * shared copy says its bookmark (when known), that it is shared, and that it
 * is read-only; a box says its state.
 */
export const workingCopyLabel = (copy: Pick<WorkingCopy, "kind" | "label" | "state" | "bookmark" | "access">): string => {
  if (copy.kind === "shared") {
    return [copy.bookmark, copy.label, ...(copy.access === "read" ? ["read-only"] : [])].filter((part) => part !== undefined).join(" · ")
  }
  return copy.state === undefined ? copy.bookmark ?? copy.label : `${copy.bookmark ?? copy.label} · ${copy.state}`
}
/** Approval wording and authority always project from the runtime record. */
const projectApprovalCard = (card: Card, request: Card | undefined): Card => {
  if (card.runtimeView?.revision !== undefined) return card
  if (card.kind === "approval" && request?.kind === "approval") {
    return { ...card, title: request.title, body: request.body, payload: {
      ...request.payload,
      decision: card.payload.decision,
      decidedAt: card.payload.decidedAt,
      pending: card.payload.pending,
      error: card.payload.error
    } }
  }
  if (card.kind === "approvals-inbox" && request?.kind === "approvals-inbox") {
    return { ...card, title: request.title, body: request.body, payload: {
      ...request.payload,
      approvals: request.payload.approvals.map((row) => {
        const state = card.payload.approvals.find((entry) => entry.runId === row.runId && entry.requestId === row.requestId)
        return { ...row, decision: state?.decision, decidedAt: state?.decidedAt, pending: state?.pending,
          decisionError: state?.decisionError }
      })
    } }
  }
  return card
}

/** Materialized views, never persisted or written by reducers. */
export const createWorkspaceViews = (
  stored: Pick<StoredCollections, "cards" | "workingCopies" | "cloudWorkspaces" | "repositories" | "approvalRequests" | "runtimeRuns" | "runtimeApprovals">
) => {
  stored.cloudWorkspaces.createIndex((workspace) => workspace.id, { indexType: BTreeIndex })
  stored.approvalRequests.createIndex((request) => request.id, { indexType: BTreeIndex })
  const bindings = createLiveQueryCollection({
    id: "app-card-bindings", startSync: true, gcTime: Infinity, getKey: card => card.id,
    query: q => q.from({ entry: q.from({ card: stored.cards }).fn.select(({ card }) => ({
      card, workspaceId: card.kind === "workspace" ? card.payload.workspaceId : undefined
    })) })
      .leftJoin({ workspace: stored.cloudWorkspaces }, ({ entry, workspace }) => eq(entry.workspaceId, workspace.id))
      .leftJoin({ request: stored.approvalRequests }, ({ entry, request }) => eq(entry.card.id, request.id))
      .fn.select(({ entry, workspace, request }): Card => projectApprovalCard(projectWorkspaceCard(entry.card, workspace), request))
  })
  // A read index, never a persisted collection or a writable domain authority.
  // Keep one pure selector for single cards and their list memberships. Nested
  // query includes cannot feed an outer fn.select reactively in this DB version.
  const cards = createCollection<Card, string>({
    id: "app-live-cards", startSync: true, gcTime: Infinity, getKey: card => card.id,
    sync: { sync: ({ begin, write, commit, markReady }) => {
      const published = new Map<string, Card>()
      const refresh = (ids: Iterable<string>) => {
        begin({ immediate: true })
        const runs = [...stored.runtimeRuns.values()], approvals = [...stored.runtimeApprovals.values()]
        for (const id of new Set(ids)) {
          const previous = published.get(id), binding = bindings.get(id)
          if (binding === undefined) {
            if (previous !== undefined) { write({ type: "delete", value: previous }); published.delete(id) }
            continue
          }
          const next = projectRuntimeCard(binding, runs, approvals)
          if (next === previous) continue
          write({ type: previous === undefined ? "insert" : "update", value: next })
          published.set(id, next)
        }
        commit()
      }
      const bindingsSubscription = bindings.subscribeChanges(changes => refresh(changes.map(change => change.value.id)), { includeInitialState: true })
      const forRepos = (repos: Set<string>) => refresh([...bindings.values()]
        .filter(card => ["run-trace", "run-list", "approval", "approvals-inbox"].includes(card.kind) && "repo" in card.payload && typeof card.payload.repo === "string" && repos.has(card.payload.repo))
        .map(card => card.id))
      const runsSubscription = stored.runtimeRuns.subscribeChanges(changes => forRepos(new Set(changes.map(change => change.value.scope.repo))))
      const approvalsSubscription = stored.runtimeApprovals.subscribeChanges(changes => forRepos(new Set(changes.map(change => change.value.scope.repo))))
      markReady()
      return () => { bindingsSubscription.unsubscribe(); runsSubscription.unsubscribe(); approvalsSubscription.unsubscribe(); void bindings.cleanup() }
    } }
  })
  return {
    cards,
    workingCopies: createLiveQueryCollection({
      id: "app-live-working-copies",
      startSync: true,
      gcTime: Infinity,
      getKey: (copy) => copy.id,
      query: (q) =>
        q.unionAll(
          q.from({ copy: stored.workingCopies })
            .leftJoin(
              { workspace: stored.cloudWorkspaces },
              ({ copy, workspace }) => eq(copy.workspaceId, workspace.id)
            )
            // Local pins and sparse legacy inventory remain readable. A full
            // workspace row always supersedes an older persisted copy.
            .where(({ workspace }) => isUndefined(workspace.id))
            .select(({ copy }) => copy),
          q.from({ cloud: stored.cloudWorkspaces }).fn.select(({ cloud }) => workspaceCopy(cloud)),
          /*
           * One shared read-only copy per public catalog repository, for as
           * long as the catalog row stands and the visitor has no box on it.
           * A box is a cloud workspace row, or an inventory copy of kind
           * workspace (the two sources a box reaches the store through).
           */
          q.from({ repository: stored.repositories })
            .leftJoin(
              { box: stored.cloudWorkspaces },
              ({ repository, box }) => eq(repository.id, box.repoId)
            )
            .leftJoin(
              {
                boxCopy: q.from({ copy: stored.workingCopies })
                  .where(({ copy }) => eq(copy.kind, "workspace"))
                  .select(({ copy }) => ({ id: copy.id, repoId: copy.repoId }))
              },
              ({ repository, boxCopy }) => eq(repository.id, boxCopy.repoId)
            )
            .where(({ repository, box, boxCopy }) => and(eq(repository.catalog, true), isUndefined(box.id), isUndefined(boxCopy.id)))
            .fn.select(({ repository }) => sharedCopyOf(repository))
        )
    })
  }
}
