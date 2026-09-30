/*
 * The one target-repo resolution rule for repo-scoped commands (issues, PRs,
 * environment, import), following the flow.create precedent (Wave 12 §2):
 * a known trailing `owner/repo` token wins; otherwise the active row
 * (lane piper: the active working copy's repository, else the selected
 * repository's head); otherwise the answer is an honest error naming the
 * choice — the target is a genuine user decision, never a guess.
 */
import { parseRepoSelection } from "./AppState"
import type { CloudRepository, CloudWorkspaceRow } from "./AppState"
import type { AppStore } from "./AppStore"
import { repositoryJobWorkspace } from "./RepositoryJobs"
import { cardContainsRun, runCardInScope, runScopeFromCard, sameRunScope, type RunScope } from "./RunReference"
import type { Card } from "./AppState"

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
  const copyId = selection?.copyId
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
 * selected.
 */
export const activeRepositoryId = (store: AppStore): string | null => {
  const key = store.session().activeRepoKey ?? null
  const selection = key === null ? null : parseRepoSelection(key)
  return selection === null ? null : selection.repoId
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
  if (selection === null) return null
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
 * The box a flow call runs on, or the sentence saying which box to open or
 * pick. A refusal that asks for a pick carries the boxes to pick from, so a
 * human's act can render the box.select form instead of the sentence
 * (controller/boxChoice.ts). UI frame IDs are unrelated.
 */
export type GatewayBinding =
  | { readonly workspaceId: string }
  | { readonly error: string; readonly choices?: ReadonlyArray<CloudWorkspaceRow> }

/** The statuses a box passes through before it runs. */
const SETTLING: ReadonlySet<string> = new Set(["pending", "starting"])

/**
 * Which of a repository's boxes an act means when none is selected — the one
 * rule, for every caller (flows here, code intelligence in
 * seams/CodeIntelSeam.ts). Exactly one running box is the answer; with none
 * running, the suspended or stopped ones (a flow call resumes exactly one,
 * as it resumes a selected one); otherwise the reason there is none, for the
 * caller to put in its own words.
 */
export type RepositoryBox =
  | { readonly kind: "box"; readonly box: CloudWorkspaceRow }
  | { readonly kind: "several"; readonly running: ReadonlyArray<CloudWorkspaceRow> }
  | { readonly kind: "resumable"; readonly box: CloudWorkspaceRow; readonly resumable: ReadonlyArray<CloudWorkspaceRow> }
  | { readonly kind: "settling"; readonly box: CloudWorkspaceRow }
  | { readonly kind: "none" }

export const repositoryBoxOf = (store: AppStore, repo: string): RepositoryBox => {
  const rows = [...store.collections.cloudWorkspaces.values()].filter((row) => row.repoId === repo)
  const running = rows.filter((row) => row.status === "running")
  if (running.length === 1) return { kind: "box", box: running[0]! }
  if (running.length > 1) return { kind: "several", running }
  const resumable = rows.filter((row) => row.status === "suspended" || row.status === "stopped")
  if (resumable.length > 0) return { kind: "resumable", box: resumable[0]!, resumable }
  const settling = rows.find((row) => SETTLING.has(row.status))
  return settling === undefined ? { kind: "none" } : { kind: "settling", box: settling }
}

/** The boxes a pick of `repo`'s box offers: the several running ones, else the several resumable ones, else the one default. */
export const repositoryBoxChoices = (store: AppStore, repo: string): ReadonlyArray<CloudWorkspaceRow> => {
  const found = repositoryBoxOf(store, repo)
  switch (found.kind) {
    case "box": return [found.box]
    case "several": return found.running
    case "resumable": return found.resumable
    case "settling":
    case "none": return []
  }
}

/** The repository's default box as a flow binding, or the act that gets one. */
export const defaultBoxBinding = (store: AppStore, repo: string): GatewayBinding => {
  const found = repositoryBoxOf(store, repo)
  switch (found.kind) {
    case "box": return { workspaceId: found.box.id }
    case "several": return { error: `Select a box of ${repo} first.`, choices: found.running }
    // Provisioning resumes it, exactly as it resumes a selected suspended box.
    case "resumable": return found.resumable.length === 1 ? { workspaceId: found.box.id } : { error: `Select a box of ${repo} first.`, choices: found.resumable }
    case "settling": return { error: `A box of ${repo} is starting.` }
    case "none": return { error: `Open a box of ${repo} first: /box.open ${repo}` }
  }
}

/** The selected working copy's box when the selection is a box of this repository; undefined when it is not a box. */
export const selectedBoxBinding = (store: AppStore, repo: string): GatewayBinding | undefined => {
  const key = store.session().activeRepoKey
  const selection = key == null ? null : parseRepoSelection(key)
  if (selection === null || selection.repoId !== repo || selection.copyId === undefined) return undefined
  const copy = store.collections.workingCopies.get(selection.copyId)
  if (copy === undefined || copy.repoId !== repo) {
    return { error: "The selected working copy is no longer available for this repository." }
  }
  if (copy.kind !== "workspace") return undefined
  const workspace = copy.workspaceId === undefined ? undefined : store.collections.cloudWorkspaces.get(copy.workspaceId)
  if (workspace === undefined || workspace.repoId !== repo) {
    return { error: "The selected box is no longer available for this repository." }
  }
  return { workspaceId: workspace.id }
}

/** Persisted provenance wins over the currently selected box. */
export const gatewayRunContextFor = (store: AppStore, runId: string):
  { readonly repo: string; readonly workspaceId?: string } | { readonly error: string } | undefined => {
  let found: RunScope | undefined
  for (const card of store.collections.cards.values()) {
    if (!cardContainsRun(card, runId)) continue
    const scope = runScopeFromCard(store, card, runId)
    if (scope === undefined) continue
    if (found !== undefined && !sameRunScope(found, scope)) {
      return { error: `The recorded run has conflicting boxes: ${found.repo}@${found.workspaceId ?? "none"} and ${scope.repo}@${scope.workspaceId ?? "none"} on card ${card.id}. Supply sourceCard to select the recorded run.` }
    }
    found = scope
  }
  return found === undefined ? undefined : { repo: found.repo, ...(found.workspaceId === undefined ? {} : { workspaceId: found.workspaceId }) }
}

/** What a run recorded before every run named its box answers. */
export const RUN_BOX_GONE = "This run's box is gone."

/** A recorded run's (or card's) box, or the refusal: one recorded with no box has none to reach. */
export const recordedRunBinding = (scope: { readonly workspaceId?: string | undefined }, gone: string = RUN_BOX_GONE): GatewayBinding =>
  scope.workspaceId === undefined ? { error: gone } : { workspaceId: scope.workspaceId }

/**
 * The box a flow call on `repo` runs on: a recorded run's own box, else the
 * selected box, else the repository's default box ({@link defaultBoxBinding}).
 * There is no box-less answer.
 */
export const gatewayBindingFor = (store: AppStore, repo: string, runId?: string): GatewayBinding => {
  if (runId !== undefined) {
    const recorded = gatewayRunContextFor(store, runId)
    if (recorded !== undefined) {
      if ("error" in recorded) return recorded
      if (recorded.repo !== repo) return { error: "The run belongs to another repository." }
      return recordedRunBinding(recorded)
    }
  }
  return selectedBoxBinding(store, repo) ?? defaultBoxBinding(store, repo)
}

/**
 * The box this repository's reviewed jobs (and the trigger registrar) run on:
 * the one their setups recorded, else the human's selected box, else the
 * repository's default box.
 */
export const repositoryJobBinding = (store: AppStore, repo: string): GatewayBinding => {
  const recorded = repositoryJobWorkspace(store.collections.cards.values(), repo, store.collections.identitySessions.get("identity")?.login ?? null)
  return recorded === undefined ? selectedBoxBinding(store, repo) ?? defaultBoxBinding(store, repo) : { workspaceId: recorded }
}

/**
 * The box a flow is authored on: the selected one, else the reviewed jobs'
 * box (which carries the authoring pack and the registrar), else the default.
 */
export const flowAuthoringBinding = (store: AppStore, repo: string): GatewayBinding =>
  selectedBoxBinding(store, repo) ?? repositoryJobBinding(store, repo)

/**
 * A run's own card. A `sourceCard` names the card the act was raised from, so
 * it must be that run's card and not another's; without one the recorded
 * gateway scope must be unambiguous before choosing its lowest-id view, just
 * as other run references resolve it.
 */
export const runCardOf = (store: AppStore, runId: string, sourceCard?: string):
  Extract<Card, { kind: "run-trace" }> | { readonly error: string } | undefined => {
  if (sourceCard !== undefined) {
    const source = store.collections.cards.get(sourceCard)
    return source?.kind === "run-trace" && source.payload.runId === runId ? source : undefined
  }
  const scope = gatewayRunContextFor(store, runId)
  if (scope === undefined || "error" in scope) return scope
  return runCardInScope(store, { ...scope, runId })
}
