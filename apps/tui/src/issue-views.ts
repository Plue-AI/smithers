/**
 * Saved issue views (#2269) for the TUI: the views the repository's factory
 * declares (`S.Factory({ issueViews })`), read from Smithers Cloud as the
 * signed-in person, and the issues one view selects, listed through the same
 * API the app and `smthrs issue list --view` use. The controller owns the
 * reads (one per view at a time, stale answers ignored, failures kept and
 * retryable); `panel` renders its state as one `ui:issue-views` tab whose
 * view rows select with Enter once the host routes `viewOf(row.id)` to
 * `select`.
 */
import type * as Panels from "./panels.ts"

/** Where a repository lives on Cloud: `owner/name`. */
export type Repository = string

/** One declared view. */
export interface View {
  readonly id: string
  readonly title: string
  readonly state?: string
  readonly labels?: ReadonlyArray<string>
}

/** One listed issue. */
export interface Issue {
  readonly number: number
  readonly title: string
  readonly state: string
}

/** The most issues one read shows; a full page says more exist. */
export const pageSize = 100

const viewId = /^[a-z0-9][a-z0-9-]{0,63}$/

const segments = (repo: Repository): string => repo.split("/").map(encodeURIComponent).join("/")

/** `GET /api/repos/{owner}/{repo}/issue-views`. */
export const viewsRoute = (repo: Repository): string => `/api/repos/${segments(repo)}/issue-views`

/** `GET /api/repos/{owner}/{repo}/issues?view=<id>&limit=<n>`. */
export const issuesRoute = (repo: Repository, view: string): string =>
  `/api/repos/${segments(repo)}/issues?view=${encodeURIComponent(view)}&limit=${pageSize}`

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseView = (value: unknown): View | undefined => {
  if (!record(value) || typeof value.id !== "string" || !viewId.test(value.id)) return undefined
  if (typeof value.title !== "string" || value.title.trim() === "") return undefined
  const labels = Array.isArray(value.labels)
    ? value.labels.filter((label): label is string => typeof label === "string")
    : []
  return {
    id: value.id,
    title: value.title,
    ...(typeof value.state === "string" && value.state !== "" ? { state: value.state } : {}),
    ...(labels.length === 0 ? {} : { labels })
  }
}

const parseIssue = (value: unknown): Issue | undefined =>
  record(value) && typeof value.number === "number" && Number.isInteger(value.number) && typeof value.title === "string"
    ? { number: value.number, title: value.title, state: typeof value.state === "string" ? value.state : "open" }
    : undefined

/** The declared views, in declaration order. A body that is not a list is an error. */
export const loadViews = async (
  get: (path: string, signal?: AbortSignal) => Promise<unknown>,
  repo: Repository,
  signal?: AbortSignal
): Promise<ReadonlyArray<View>> => {
  const body = await get(viewsRoute(repo), signal)
  if (!Array.isArray(body)) throw new Error("Cloud answered the issue views with an unreadable payload")
  return body.flatMap((entry) => {
    const view = parseView(entry)
    return view === undefined ? [] : [view]
  })
}

/** The first page of one view's issues; `more` when the page is full. */
export const loadIssues = async (
  get: (path: string, signal?: AbortSignal) => Promise<unknown>,
  repo: Repository,
  view: string,
  signal?: AbortSignal
): Promise<{ readonly issues: ReadonlyArray<Issue>; readonly more: boolean }> => {
  const body = await get(issuesRoute(repo, view), signal)
  if (!Array.isArray(body)) throw new Error("Cloud answered the issues with an unreadable payload")
  const issues = body.flatMap((entry) => {
    const issue = parseIssue(entry)
    return issue === undefined ? [] : [issue]
  })
  return { issues, more: body.length >= pageSize }
}

/** One view's read. */
export type Selection =
  | { readonly id: string; readonly phase: "loading" }
  | { readonly id: string; readonly phase: "loaded"; readonly issues: ReadonlyArray<Issue>; readonly more: boolean }
  | { readonly id: string; readonly phase: "failed"; readonly detail: string }

/** What the tab shows. */
export type State =
  | { readonly phase: "idle" }
  | { readonly phase: "signed-out" }
  | { readonly phase: "failed"; readonly detail: string }
  | { readonly phase: "ready"; readonly views: ReadonlyArray<View>; readonly selected?: Selection }

/** The session the reads use: `CloudSession.signedIn`'s `get`. */
export interface Cloud {
  readonly get: (path: string, signal?: AbortSignal) => Promise<unknown>
}

const detail = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** A 401 or 403: the session is gone or may not read the repository. */
const refused = (error: unknown): boolean => /HTTP 40[13]\b/.test(String(error))

/** The row id of a view; `viewOf` reads it back. */
export const rowId = (view: string): string => `issue-view:${view}`

/** The view a row names, or undefined for any other row. */
export const viewOf = (row: string): string | undefined => {
  const view = row.startsWith("issue-view:") ? row.slice("issue-view:".length) : ""
  return viewId.test(view) ? view : undefined
}

/**
 * The views and the selected view's issues for `repo`. `refresh` reads the
 * views (keeping a selection that is still declared); `select` reads one
 * view's issues. A second `select` of the view in flight joins it; a newer
 * selection wins over an older answer. A failed read is kept, not retried:
 * `select` again retries it.
 */
export const controller = (
  signIn: () => Promise<Cloud | undefined>,
  repo: Repository | undefined,
  onChange: (state: State) => void = () => {}
) => {
  let state: State = { phase: "idle" }
  let cloud: Cloud | undefined
  let generation = 0
  let flying: { readonly id: string; readonly run: Promise<State> } | undefined
  const set = (next: State): State => {
    state = next
    onChange(state)
    return state
  }
  const session = async (): Promise<Cloud | undefined> => cloud ??= await signIn()
  const refresh = async (signal?: AbortSignal): Promise<State> => {
    if (repo === undefined) return state
    try {
      const signed = await session()
      if (signed === undefined) return set({ phase: "signed-out" })
      const views = await loadViews(signed.get, repo, signal)
      if (signal?.aborted) return state
      const previous = state.phase === "ready" ? state.selected : undefined
      const selected = previous !== undefined && views.some((view) => view.id === previous.id) ? previous : undefined
      return set({ phase: "ready", views, ...(selected === undefined ? {} : { selected }) })
    } catch (error) {
      if (signal?.aborted) return state
      if (refused(error)) {
        cloud = undefined
        return set({ phase: "signed-out" })
      }
      return set({ phase: "failed", detail: detail(error) })
    }
  }
  const select = (id: string, signal?: AbortSignal): Promise<State> => {
    if (state.phase !== "ready" || repo === undefined || !state.views.some((view) => view.id === id)) {
      return Promise.resolve(state)
    }
    if (flying?.id === id) return flying.run
    const mine = ++generation
    set({ ...state, selected: { id, phase: "loading" } })
    const run = (async (): Promise<State> => {
      let selection: Selection
      try {
        const signed = await session()
        if (signed === undefined) {
          if (mine === generation) return set({ phase: "signed-out" })
          return state
        }
        const page = await loadIssues(signed.get, repo, id, signal)
        selection = { id, phase: "loaded", ...page }
      } catch (error) {
        if (refused(error)) cloud = undefined
        selection = { id, phase: "failed", detail: detail(error) }
      }
      // An older answer never replaces a newer selection, nor a reset.
      if (mine !== generation || signal?.aborted || state.phase !== "ready") return state
      return set({ ...state, selected: selection })
    })().finally(() => {
      if (flying?.run === run) flying = undefined
    })
    flying = { id, run }
    return run
  }
  return { refresh, select, state: (): State => state }
}

/** The panel id; the surface is `ui:issue-views`. */
export const id = "issue-views"

const filters = (view: View): string =>
  [view.state === undefined || view.state === "all" ? undefined : view.state, ...(view.labels ?? [])]
    .filter((part): part is string => part !== undefined).join(" · ")

/** The `ui:issue-views` tab: one row per view, then the selected view's issues. */
export const panel = (state: State): Panels.Panel => {
  if (state.phase !== "ready") {
    return {
      id,
      title: "Issue views",
      summary: state.phase === "signed-out"
        ? "Sign in: smthrs auth login"
        : state.phase === "failed"
        ? "Views unavailable"
        : "Reading views",
      rows: state.phase === "failed"
        ? [{
          id: "issue-views:failed",
          label: state.detail.slice(0, 240) || "Read failed",
          status: "failed",
          details: []
        }]
        : []
    }
  }
  const { views, selected } = state
  const chosen = views.find((view) => view.id === selected?.id)
  const summary = chosen === undefined || selected === undefined
    ? `${views.length} ${views.length === 1 ? "view" : "views"}`
    : selected.phase === "loaded"
    ? `${chosen.title} · ${selected.issues.length}${selected.more ? "+" : ""}`
    : chosen.title
  const viewRows: ReadonlyArray<Panels.Row> = views.map((view) => ({
    id: rowId(view.id),
    label: view.title,
    ...(selected?.id !== view.id
      ? {}
      : {
        status: selected.phase === "loading"
          ? "requested" as const
          : selected.phase === "failed"
          ? "failed" as const
          : "done" as const
      }),
    details: filters(view) === "" ? [] : [{ kind: "text" as const, text: filters(view) }]
  }))
  const issueRows: ReadonlyArray<Panels.Row> = selected === undefined
    ? []
    : selected.phase === "failed"
    ? [{
      id: `issue-view-failed:${selected.id}`,
      label: selected.detail.slice(0, 240) || "Read failed",
      status: "failed",
      details: []
    }]
    : selected.phase === "loaded"
    ? selected.issues.map((issue) => ({
      id: `issue-view-issue:${selected.id}:${issue.number}`,
      label: `#${issue.number} ${issue.title}`.slice(0, 240),
      details: [{ kind: "text" as const, text: issue.state }]
    }))
    : []
  return { id, title: "Issue views", summary, rows: [...viewRows, ...issueRows] }
}
