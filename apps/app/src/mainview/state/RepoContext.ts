/*
 * The one target-repo resolution rule for repo-scoped commands (issues, PRs,
 * environment, import), following the flow.create precedent (Wave 12 §2):
 * a known trailing `owner/repo` token wins; otherwise the active row
 * (lane piper: the active working copy's repository, else the selected
 * repository's head); otherwise the answer is an honest error naming the
 * choice — the target is a genuine user decision, never a guess.
 */
import type { Repo } from "@smthrs/rpc/LocalApp"
import { activeRepoOf, parseRepoSelection } from "./AppState"
import type { CloudRepository } from "./AppState"
import type { AppStore } from "./AppStore"
import { cardContainsRun, runScopeFromCard, sameRunScope, type RunScope } from "./RunReference"

/** The `owner/repo` shape; exported for the grammars that take a LEADING repo token (agent.session.new). */
export { REPO_TOKEN } from "@smthrs/ui/command-line"
import { REPO_TOKEN } from "@smthrs/ui/command-line"

/**
 * The repositories a trailing token may name in argument text: every
 * loaded repository and the active working copy's repository. What
 * {@link splitTrailingRepo} checks an ambiguous token against.
 */
export type KnownRepositories = Pick<ReadonlySet<string>, "has">

/** {@link KnownRepositories} read from the store. */
export const knownRepositories = (store: AppStore): KnownRepositories => {
  const known = new Set<string>(store.collections.repositories.keys())
  // A completed import is authoritative before the repository inventory refreshes.
  // Use the returned repository, never the name of a pending import request.
  for (const card of store.collections.cards.values()) {
    if (card.kind !== "repo-import" || card.payload.phase !== "done" || card.payload.repository == null) continue
    const repo = `${card.payload.repository.owner}/${card.payload.repository.name}`
    if (REPO_TOKEN.test(repo)) known.add(repo)
  }
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  const copyId = selection === null ? undefined : "repoId" in selection ? selection.copyId : selection.localCopyId
  const copy = copyId === undefined ? undefined : store.collections.workingCopies.get(copyId)
  if (copy !== undefined && REPO_TOKEN.test(copy.repoId)) known.add(copy.repoId)
  return known
}

/**
 * Splits a trailing `owner/repo` token off a command's argument text.
 *
 * A token is ambiguous (`src/index.ts` and `packages/rpc` are repo-shaped
 * too). With `known` in hand it is the target only when it names a loaded
 * repository or the active working copy's repository; otherwise the text stays whole
 * and the ambient repository is the target. Without `known` the shape alone decides.
 */
export const splitTrailingRepo = (
  args: string | undefined,
  known?: KnownRepositories
): { readonly rest: string; readonly repo?: string } => {
  const text = (args ?? "").trim()
  if (text === "") return { rest: "" }
  const parts = text.split(/\s+/)
  const last = parts[parts.length - 1] ?? ""
  if (parts.length > 0 && REPO_TOKEN.test(last)) {
    if (known !== undefined && !known.has(last)) return { rest: text }
    return { rest: text.slice(0, -last.length).trimEnd(), repo: last }
  }
  return { rest: text }
}

/**
 * The `owner/name` the active selection names: the selected repository, or
 * the repository behind the selected working copy. Null when nothing is
 * selected or the selection is a local-only checkout.
 */
export const activeRepositoryId = (store: AppStore): string | null => {
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  if (selection === null) return null
  if ("repoId" in selection) return selection.repoId
  const copy = store.collections.workingCopies.get(selection.localCopyId)
  return copy !== undefined && REPO_TOKEN.test(copy.repoId) ? copy.repoId : null
}

/**
 * The `owner/name` the selection names when the public catalog supplied it
 * (apps/server/PUBLIC-REPOSITORIES.md): the one repository a signed-out
 * visitor reads and talks about. Null for any other selection.
 */
export const catalogRepositoryOf = (
  activeRepoKey: string | null | undefined,
  repositories: Iterable<Pick<CloudRepository, "id" | "catalog">>
): string | null => {
  const selection = activeRepoKey === undefined || activeRepoKey === null ? null : parseRepoSelection(activeRepoKey)
  if (selection === null || !("repoId" in selection)) return null
  for (const repository of repositories) {
    if (repository.id === selection.repoId) return repository.catalog === true ? selection.repoId : null
  }
  return null
}

/** {@link catalogRepositoryOf} read from the store. */
export const activeCatalogRepositoryId = (store: AppStore): string | null =>
  catalogRepositoryOf(store.session().activeRepoKey, store.collections.repositories.values())

const repositoryEntryRefusal = (store: AppStore): string | undefined => {
  const entry = store.session().repositoryEntry
  if (entry?.phase === "pending") return `Opening ${entry.repo}. Try again when it is ready.`
  if (entry?.phase === "failed") return entry.error ?? `${entry.repo} could not be opened.`
}

/** The resolved target repository, or the honest error stating the choice. */
export const resolveTargetRepo = (
  store: AppStore,
  explicit: string | undefined
): { readonly repo: string } | { readonly error: string } => {
  if (explicit !== undefined && explicit !== "") {
    if (!REPO_TOKEN.test(explicit)) {
      return { error: `"${explicit}" is not an owner/repo name` }
    }
    return { repo: explicit }
  }
  const refusal = repositoryEntryRefusal(store)
  if (refusal !== undefined) return { error: refusal }
  /*
   * Lane piper: the active selection is the target — a working copy's
   * repository, the selected repository, or a local-only checkout. A
   * single loaded repository is the target when nothing is selected.
   */
  const active = activeRepositoryId(store)
  if (active !== null) return { repo: active }
  const loaded = [...store.collections.repositories.values()]
  if (loaded.length === 1) return { repo: loaded[0]!.id }
  if (loaded.length === 0) {
    return { error: "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo" }
  }
  return {
    error: `Several repositories are loaded (${loaded.map((repo) => repo.id).join(", ")}) — name one as owner/repo`
  }
}

/**
 * The resolved repository source a repo-scoped command reads: the explicit
 * token when the line carries one, else the selection. Admission and the seam
 * ask the same question here, so raw argument text can never authorize a
 * target the seam would not resolve. An unresolvable target is no source.
 */
export const repositorySource = (
  store: AppStore,
  explicit: string | undefined
): { readonly repo?: string } => {
  const target = resolveTargetRepo(store, explicit)
  return "error" in target ? {} : { repo: target.repo }
}

/**
 * The open LOCAL repository a bare repo-scoped command means (files, targets,
 * graph): the active working copy when it is a checkout open here (lane
 * piper: "the active working copy if one is active, else head" — a head
 * selection has no local checkout, which is an honest error for a LOCAL
 * command). Local-only checkouts are resolved through the same working-copy
 * collection as remote-backed checkouts.
 */
export const resolveOpenRepo = (store: AppStore): { readonly repo: Repo } | { readonly error: string } => {
  const refusal = repositoryEntryRefusal(store)
  if (refusal !== undefined) return { error: refusal }
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  if (selection !== null) {
    const copyId = "repoId" in selection ? selection.copyId : selection.localCopyId
    if (copyId !== undefined) {
      const copy = store.collections.workingCopies.get(copyId)
      if (copy?.kind === "local" && copy.path !== undefined) {
        const open = [...store.collections.repos.values()].find((repo) => repo.path === copy.path)
        if (open !== undefined) return { repo: open }
      }
      return { error: "The active working copy is not open on this machine — open it with /repo.open first." }
    }
    if ("repoId" in selection) {
      return { error: `${selection.repoId} is selected at its head — open a local working copy with /repo.open first.` }
    }
    return { error: "Open a repository first." }
  }
  const active = activeRepoOf(store.session(), store.collections.repos.values())
  return active === undefined ? { error: "Open a repository first." } : { repo: active }
}

/** Exact Plue workspace selection for the gateway; UI frame IDs are unrelated. */
export type GatewayBinding = { readonly workspaceId?: string } | { readonly error: string }
/** Persisted provenance wins over the currently selected workspace, including legacy omission. */
export const gatewayRunContextFor = (store: AppStore, runId: string):
  { readonly repo: string; readonly workspaceId?: string } | { readonly error: string } | undefined => {
  let found: RunScope | undefined
  for (const card of store.collections.cards.values()) {
    if (!cardContainsRun(card, runId)) continue
    const scope = runScopeFromCard(store, card, runId)
    if (scope === undefined) continue
    if (found !== undefined && !sameRunScope(found, scope)) {
      return { error: `The recorded run has conflicting gateway workspaces: ${found.repo}@${found.workspaceId ?? "legacy (no workspace)"} and ${scope.repo}@${scope.workspaceId ?? "legacy (no workspace)"} on card ${card.id}. Supply sourceCard to select the recorded run.` }
    }
    found = scope
  }
  return found === undefined ? undefined : { repo: found.repo, ...(found.workspaceId === undefined ? {} : { workspaceId: found.workspaceId }) }
}

export const gatewayBindingFor = (store: AppStore, repo: string, runId?: string): GatewayBinding => {
  if (runId !== undefined) {
    const recorded = gatewayRunContextFor(store, runId)
    if (recorded !== undefined) {
      if ("error" in recorded) return recorded
      if (recorded.repo !== repo) return { error: "The run belongs to another repository." }
      return recorded.workspaceId === undefined ? {} : { workspaceId: recorded.workspaceId }
    }
  }
  const key = store.session().activeRepoKey
  const selection = key == null ? null : parseRepoSelection(key)
  if (selection === null || !("repoId" in selection) || selection.repoId !== repo || selection.copyId === undefined) return {}
  const copy = store.collections.workingCopies.get(selection.copyId)
  if (copy === undefined || copy.repoId !== repo) {
    return { error: "The selected working copy is no longer available for this repository." }
  }
  if (copy.kind !== "workspace") return {}
  const workspace = copy.workspaceId === undefined ? undefined : store.collections.cloudWorkspaces.get(copy.workspaceId)
  if (workspace === undefined || workspace.repoId !== repo) {
    return { error: "The selected box is no longer available for this repository." }
  }
  return { workspaceId: workspace.id }
}
