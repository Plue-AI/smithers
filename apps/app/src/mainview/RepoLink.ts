import { installRequestId } from "./state/seams/InstallRequestId"
import { AUTH_SIGNED_IN_PARAM } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import type { AppController } from "./state/AppController"
import type { AppStore } from "./state/AppStore"
import { parseRepoSelection,repoTreeRowId,sharedCopyIdOf } from "./state/AppState"

/*
 * A repository's app lives at `/owner/name` (https://smithers.sh/smithersai/smithers).
 * The landing page's older "Open in Smithers" link lands on `/?repo=owner/name`.
 * The path wins; the parameter is read only at `/`. The name is honoured only
 * when the signed-in inventory or public catalog (GET /api/public/repos)
 * carries it: a catalog row enters the repositories collection
 * and becomes the active selection, so the first turn is about that
 * repository. The path stays in the address bar, so a reload reselects; the
 * parameter is removed from the URL either way, so a reload does not.
 */

export const REPO_PARAM = "repo"
export const PUBLIC_REPOS_PATH = "/api/public/repos"

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/

/**
 * The `owner/name` a `/owner/name` path names (exactly two segments), or null
 * for any other path. A trailing slash is the same repository: a prerendered
 * `/owner/name/index.html` is served at `/owner/name/` by hosts that do not
 * strip it.
 */
export const pathRepo = (pathname: string): string | null => {
  const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(pathname)
  if (match === null) return null
  const value = `${match[1]}/${match[2]}`
  return REPO_NAME.test(value) ? value : null
}

/** The `owner/name` the `repo` parameter names, or null when absent or not a repository name. */
export const paramRepo = (search: string): string | null => {
  const value = new URLSearchParams(search).get(REPO_PARAM)?.trim() ?? ""
  return REPO_NAME.test(value) ? value : null
}

/** The `owner/name` the URL asks for: the `/owner/name` path first, else the `repo` parameter at `/`. */
export const requestedRepo = (location: Pick<Location, "pathname" | "search">): string | null =>
  pathRepo(location.pathname) ?? (location.pathname === "/" ? paramRepo(location.search) : null)

export interface CatalogRepository {
  /** `owner/name`, in the catalog's spelling. */
  readonly id: string
  readonly org: string
  readonly name: string
  /** The catalog's curated one-sentence explanation, when it carries one. */
  readonly summary?: string
}

/** Valid repository identities from the live catalog, in its published order. */
export const catalogRepositories = (catalog: unknown): Array<CatalogRepository> => {
  if (typeof catalog !== "object" || catalog === null) return []
  const repos: unknown = (catalog as { readonly repos?: unknown }).repos
  if (!Array.isArray(repos)) return []
  const repositories: Array<CatalogRepository> = []
  const seen = new Set<string>()
  for (const entry of repos) {
    const name: unknown = typeof entry === "object" && entry !== null ? (entry as { readonly name?: unknown }).name : undefined
    if (typeof name !== "string" || !REPO_NAME.test(name) || name.split("/").some(part => part === "." || part === "..") || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const slash = name.indexOf("/")
    const summary: unknown = (entry as { readonly summary?: unknown }).summary
    repositories.push({
      id: name,
      org: name.slice(0, slash),
      name: name.slice(slash + 1),
      ...(typeof summary === "string" && summary.trim() !== "" ? { summary: summary.trim() } : {})
    })
  }
  return repositories
}

/** The catalog entry the request names; the catalog's spelling wins. */
export const catalogRepository = (catalog: unknown, requested: string): CatalogRepository | null =>
  catalogRepositories(catalog).find(repository => repository.id.toLowerCase() === requested.toLowerCase()) ?? null

/*
 * The server drops a longer return path (apps/server validReturnTo), so the
 * client sends the bare page rather than lose the whole return.
 */
const RETURN_TO_MAX_BYTES = 512

/** URLSearchParams adds '=' to flags; keep the tutorial's published bare key. */
const queryString = (params: URLSearchParams): string => params.toString()

/**
 * The page a sign-in started from a repository path returns to: the path and
 * its query, minus the auth markers a previous return spent (`signed-in`,
 * `auth`), so they are never replayed. Null anywhere but `/owner/name`: the
 * landing page is where the callback lands on its own.
 */
export const signInReturnTo = (location: Pick<Location, "pathname" | "search">): string | null => {
  if (pathRepo(location.pathname) === null) return null
  const params = new URLSearchParams(location.search)
  params.delete(AUTH_SIGNED_IN_PARAM)
  params.delete("auth")
  const search = queryString(params)
  const withSearch = `${location.pathname}${search === "" ? "" : `?${search}`}`
  return new TextEncoder().encode(withSearch).byteLength > RETURN_TO_MAX_BYTES ? location.pathname : withSearch
}

/** The same location without the repo parameter; other parameters and the fragment stay. */
export const withoutRepoParam = (location: Pick<Location, "pathname" | "search" | "hash">): string => {
  const params = new URLSearchParams(location.search)
  params.delete(REPO_PARAM)
  const search = queryString(params)
  return `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`
}

/** A repository URL must not discard that repository's selected working copy. */
const selectionForRepo = (controller: Pick<AppController, "store">, repo: string): string => {
  const key = controller.store.session().activeRepoKey
  const selected = key == null ? null : parseRepoSelection(key)
  if (selected && selected.repoId === repo && selected.copyId !== undefined &&
    controller.store.collections.workingCopies.get(selected.copyId)?.repoId === repo) return key!
  return repo
}

/**
 * The repository document's default bookmark, read from the public mirror
 * (`GET /api/repos/{o}/{r}`, a public repository read the Worker forwards
 * with no credentials): the bookmark the shared read-only copy tracks. The
 * catalog itself carries no head, so this is the one honest source signed
 * out. Null when the document cannot be read or names no default bookmark:
 * the copy then shows no bookmark, never an invented one.
 */
const defaultBookmarkOf = async (http: FetchLike, repo: string): Promise<string | null> => {
  const [owner = "", name = ""] = repo.split("/")
  try {
    const response = await http(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { headers: { accept: "application/json" } })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const bookmark: unknown = typeof body === "object" && body !== null ? (body as { readonly default_bookmark?: unknown }).default_bookmark : undefined
    return typeof bookmark === "string" && bookmark !== "" ? bookmark : null
  } catch {
    return null
  }
}

/** Record the URL before the controller starts any background inventory work. */
export const beginRepositoryEntry = (store: AppStore, requested: string | null): string | undefined => {
  const requestId = requested === null ? undefined : installRequestId()
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: requested === null ? null : {
    requestId: requestId!, repo: requested, phase: "pending"
  } })
  return requestId
}

/**
 * Select the requested repository from the signed-in inventory or public catalog. The
 * catalog row joins the repositories collection beside whatever the cloud
 * inventory already loaded, then `repo.select` makes it the active one.
 * The repository's shared read-only copy (WorkspaceViews.ts)
 * opens its root in the sidebar on this first paint, and the mirror's
 * default bookmark lands on the row so the copy names it. Returns the
 * refusal when the request could not be honoured.
 * A command retry can resolve admission without activating the repository;
 * its caller also supplies the account/selection ownership check.
 */
export const openRequestedRepo = async (
  controller: Pick<AppController, "store" | "selectRepo" | "runCommand" | "loadRepositories">,
  http: FetchLike,
  requested: string,
  requestId = beginRepositoryEntry(controller.store, requested)!,
  viewportWidth = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth,
  options: { readonly activate?: boolean; readonly isCurrent?: () => boolean; readonly scope?: "command" } = {}
): Promise<string | void> => {
  const entry = () => options.scope === "command" ? controller.store.session().repositoryCommandEntry : controller.store.session().repositoryEntry
  const current = () => entry()?.requestId === requestId && (options.isCurrent?.() ?? true)
  const finish = (error?: string, failureKind: "unavailable" | "not-public" = "unavailable", publicRepositories?: ReadonlyArray<string>): string | void => {
    if (!current()) return
    const result = {
      requestId, repo: requested, phase: error === undefined ? "ready" : "failed", ...(error === undefined ? {} : { error, failureKind }),
      ...(publicRepositories === undefined ? {} : { publicRepositories: [...publicRepositories] })
    } as const
    if (options.scope === "command") {
      const owned = controller.store.session().repositoryCommandEntry
      if (owned?.requestId === requestId) controller.store.dispatch({ type: "repository.command.changed", actor: "system", entry: { ...result, owner: owned.owner } })
    } else controller.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: result })
    return error
  }
  let catalog: unknown
  try {
    const response = await http(PUBLIC_REPOS_PATH, { headers: { accept: "application/json" } })
    if (!response.ok) return finish(`The public repository catalog answered HTTP ${response.status}.`)
    catalog = await response.json()
  } catch {
    // A dropped request or an unreadable body: its thrown text is never copy.
    return finish("The public repository catalog could not be read.")
  }
  if (!current()) return
  if (typeof catalog !== "object" || catalog === null || !Array.isArray((catalog as { repos?: unknown }).repos)) return finish("The public repository catalog could not be read.")
  const repository = catalogRepository(catalog, requested)
  if (repository === null) {
    // A URL grants no access. A signed-in user's inventory is the authority
    // for repositories outside the public catalog; wait for that read before selecting.
    if (controller.store.collections.identitySessions.get("identity")?.state === "signed-in") {
      const failure = await controller.loadRepositories()
      if (!current()) return
      const own = [...controller.store.collections.repositories.values()].find((repo) => repo.id.toLowerCase() === requested.toLowerCase() && repo.catalog !== true)
      if (failure === undefined && own !== undefined) {
        if (options.activate === false || options.scope === "command") return finish()
        const refusal = await controller.selectRepo(selectionForRepo(controller, own.id))
        return finish(refusal === undefined ? undefined : refusal)
      }
    }
    // App's route welcome names this path and owns its sign-in door.
    return finish(`${requested} is not in the public repository catalog.`, "not-public",
      catalogRepositories(catalog).map(repo => repo.id).filter(id => id.toLowerCase() !== requested.toLowerCase()))
  }
  const { repositories } = controller.store.collections
  const existing = repositories.get(repository.id)
  if (existing?.catalog !== true) {
    controller.store.dispatch({
      type: "repository.upserted",
      actor: "system",
      /*
       * The catalog carries no owner kind and no head. "user" is the
       * conservative reading: the one consumer (the org changesets read)
       * treats it as "no org changesets", never as a fabricated org.
       * `catalog` records where the row came from: readable signed out.
       */
      repository: { ...existing, ...repository, ownerKind: existing?.ownerKind ?? "user", head: existing?.head ?? null, catalog: true }
    })
  }
  if (options.activate === false || options.scope === "command") return finish()
  const refusal = await controller.selectRepo(selectionForRepo(controller, repository.id))
  if (!current()) return
  if (refusal !== undefined) return finish(refusal)
  finish()
  /*
   * The shared copy's tree opens once, on the first paint of the catalog
   * repository on wide screens: `repo.tree <copyId>` through the registry, the same act the
   * caret runs. The tree rows live for this launch only, so a row already
   * there is this launch's own state, and the caret is the visitor's. On a
   * phone this opens an obstructing drawer; keep the explicit tree action.
   */
  const sharedId = sharedCopyIdOf(repository.id)
  if (
    viewportWidth > 600 &&
    controller.store.collections.workingCopies.get(sharedId) !== undefined &&
    controller.store.collections.repoTree.get(repoTreeRowId(sharedId, "")) === undefined
  ) {
    controller.runCommand("repo.tree", sharedId)
  }
  const bookmark = await defaultBookmarkOf(http, repository.id)
  if (!current()) return
  const row = controller.store.collections.repositories.get(repository.id)
  if (bookmark === null || row === undefined || row.head !== null) return
  controller.store.dispatch({
    type: "repository.upserted",
    actor: "system",
    repository: { ...row, head: { bookmark, changeId: null, commitId: null } }
  })
}
