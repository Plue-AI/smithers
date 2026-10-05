/*
 * The sidebar's file tree seam: one
 * directory of a working copy, written to the `app-repo-tree` row for that
 * directory. A cloud WORKSPACE copy (a box) reads through the route its
 * Files facet uses (`GET /api/repos/{o}/{r}/workspaces/{id}/files?path=`,
 * WorkspaceSeam.loadFiles). The SHARED copy of a public repository (the
 * read-only virtual box every reader shares, lane plan B2) reads
 * through the public contents route the files flows read
 * (`GET /api/repos/{o}/{r}/contents[/path]`, forwarded to the Smithers Cloud
 * mirror with no credentials: apps/server publicRepositoryReads.ts). Those
 * are the only two routes: the app offers the web app's feature set, so a
 * copy that is neither is refused in place (apps/app/docs/
 * LOCAL-BACKEND-RETIREMENT.md). The row is what the sidebar renders:
 * `loaded` with exactly the entries the route returned (no filtering,
 * nothing invented), or `failed` with the route's error text verbatim, shown
 * in place. Every row holds its directory in the one order a listing reads
 * in (`@smthrs/rpc/FileList` `sortEntries`: directories first, then by name), because the
 * two routes do not agree on one — the mirror answers a git tree's byte
 * order — and the sidebar reads the same for a box and the shared copy. A
 * path that leaves the repository is refused before any route is asked
 * (FilesSeam.unsafePath), because the encodings these URLs use leave `..`
 * alone. Never throws.
 */
import { isRecord } from "@smthrs/canonical/Record"
import type { RepoTreeEntry, WorkingCopy } from "../AppState"
import { createCloudClient } from "./CloudClient"
import { readContentsPages } from "./ContentsPages"
import { sortEntries } from "@smthrs/rpc/FileList"
import { encodeRepoPath, parseEntry, unsafePath } from "./FilesSeam"
import { readErrorMessage, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface RepoTreeSeam {
  /** Load one directory (`""` = the root) of a working copy into its tree row. */
  readonly loadDirectory: (copyId: string, path: string) => Promise<void>
}

/** A relative directory path with no leading, trailing, or doubled slashes. */
export const normalizeTreePath = (path: string): string => path.split("/").filter((segment) => segment !== "").join("/")

/**
 * Why a box cannot list files right now, in the state the inventory holds
 * for it. `undefined` for a running box: the route is asked, and its own
 * answer stands. A `failed` box never settles (the settle watch polls only
 * pending/starting) and cannot be resumed; plue's failure_message rides on
 * the workspace row, so the card is where the reason shows.
 */
export const workspaceTreeRefusal = (copy: WorkingCopy): string | undefined => {
  if (copy.state === undefined || copy.state === "running") return undefined
  const name = `${copy.label} (${copy.workspaceId ?? copy.id})`
  if (copy.state === "failed") return `${name} is failed; the workspace card names why.`
  const remedy = copy.state === "suspended" || copy.state === "stopped"
    ? "/box.resume it first"
    : "wait for it to settle (the workspace card tracks it)"
  return `${name} is ${copy.state}, not running; ${remedy}.`
}

/**
 * The `/workspaces/{id}/files` path of a box, under the repository the copy
 * names (`org/repo`). The route reads a directory; the entry shape is plue's
 * WorkspaceFileEntry (`name`, `path`, `type: "dir" | "file"`, `size`).
 */
const workspaceFilesPath = (repoId: string, workspaceId: string): string => {
  const [owner = "", name = ""] = repoId.split("/")
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(workspaceId)}/files`
}

/** plue's entries as tree rows: a row without a name drops, a `dir` type is a directory, anything else a file. */
const treeEntriesOf = (body: unknown): ReadonlyArray<RepoTreeEntry> => {
  const entries = isRecord(body) && Array.isArray(body.entries) ? body.entries : []
  return sortEntries(entries.flatMap((entry): ReadonlyArray<RepoTreeEntry> => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") return []
    return [{ name: entry.name, kind: entry.type === "dir" ? "dir" : "file" }]
  }))
}

/**
 * The public contents path of a directory in a repository's mirror: the URL
 * FilesSeam lists with (`/api/repos/{o}/{r}/contents[/path]`, per-segment
 * encoding), under the app's own origin so the Worker forwards it.
 */
export const sharedContentsPath = (repoId: string, path: string): string => {
  const [owner = "", name = ""] = repoId.split("/")
  const base = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
  return path === "" ? base : `${base}/${encodeRepoPath(path)}`
}

export const createRepoTreeSeam = (ctx: SeamContext): RepoTreeSeam => {
  const { get: getJson } = createCloudClient(ctx)
  const failed = (copyId: string, path: string, error: string): void => {
    ctx.dispatch({ type: "repo-tree.failed", actor: "system", copyId, path, error })
  }
  /*
   * The shared copy's directory: the mirror's listing, a JSON array of
   * `{ name, path, type }` rows (FilesSeam.parseEntry drops a malformed one).
   * A record instead of an array is the route's answer for a file path. A
   * refusal reaches the row in the route's words, so a repository the mirror
   * does not hold says what the mirror said.
   */
  const loadSharedDirectory = async (copy: WorkingCopy, path: string): Promise<void> => {
    const label = path === "" ? "/" : path
    let response: Response
    let body: unknown
    try {
      const answer = await readContentsPages(ctx.http, `${ctx.baseUrl}${sharedContentsPath(copy.repoId, path)}`)
      if (answer.kind === "error") {
        failed(copy.id, path, answer.error)
        return
      }
      response = answer.response
      body = answer.body
    } catch (error) {
      failed(copy.id, path, unreachableSentence(`the backend to list ${label} in ${copy.repoId}`, error))
      return
    }
    if (!response.ok) {
      const fallback = response.status === 404 ? `Path not found: ${label} in ${copy.repoId}` : `Listing ${label} in ${copy.repoId} failed (${response.status})`
      failed(copy.id, path, await readErrorMessage(response, fallback))
      return
    }
    if (!Array.isArray(body)) {
      failed(
        copy.id,
        path,
        isRecord(body) && ("content" in body || "encoding" in body)
          ? `${path} in ${copy.repoId} is a file; run /files.read ${path} instead`
          : `The backend answered ${label} in ${copy.repoId} with an unreadable payload`
      )
      return
    }
    const entries = sortEntries(body.flatMap((entry): ReadonlyArray<RepoTreeEntry> => {
      const parsed = parseEntry(entry)
      return parsed === null ? [] : [parsed]
    }))
    ctx.dispatch({ type: "repo-tree.loaded", actor: "system", copyId: copy.id, path, entries, truncated: false })
  }
  /*
   * A box's directory: refused in place while the box is not running (its
   * state sentence, nothing invented), otherwise the route's answer. The
   * Worker forwards the path with the visitor's own session, so a signed-out
   * page gets the Worker's refusal verbatim.
   */
  const loadWorkspaceDirectory = async (copy: WorkingCopy, path: string): Promise<void> => {
    const refusal = workspaceTreeRefusal(copy)
    if (refusal !== undefined) {
      failed(copy.id, path, refusal)
      return
    }
    const label = path === "" ? "/" : path
    const answer = await getJson(
      `${workspaceFilesPath(copy.repoId, copy.workspaceId ?? copy.id)}?path=${encodeURIComponent(path)}`,
      `${label} in ${copy.label}`
    )
    if ("error" in answer) {
      failed(copy.id, path, answer.error)
      return
    }
    ctx.dispatch({ type: "repo-tree.loaded", actor: "system", copyId: copy.id, path, entries: treeEntriesOf(answer.body), truncated: false })
  }
  const loadDirectory: RepoTreeSeam["loadDirectory"] = async (copyId, pathArg) => {
    const path = normalizeTreePath(pathArg)
    /*
     * The one guard both routes share (FilesSeam.unsafePath, the same
     * refusal the files flows answer). `normalizeTreePath` drops empty
     * segments and nothing else, and per-segment encoding leaves `..`
     * alone, so a caller's `..` would collapse in the URL and address a
     * route outside the repository's namespace with the visitor's own
     * cookies. Refused before any request, in place, in the seam's words.
     */
    if (unsafePath(path)) {
      failed(copyId, path, "File paths must stay inside the repository.")
      return
    }
    const copy = ctx.store.collections.workingCopies.get(copyId)
    if (copy === undefined) {
      failed(copyId, path, `There is no working copy with id ${copyId}.`)
      return
    }
    if (copy.kind === "workspace") {
      await loadWorkspaceDirectory(copy, path)
      return
    }
    await loadSharedDirectory(copy, path)
  }
  return { loadDirectory }
}
