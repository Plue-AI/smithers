import { captureCloudOwner } from "./SeamContext"
import { renderPlanLimit } from "./HostedBilling"
import { Effect, Exit, Fiber, FiberMap, Layer, ManagedRuntime, Schedule, Scope } from "effect"
import { preparedView, type ViewAction } from "../PreparedView"
import { refuseCloudSignIn, SIGN_OUT_REFUSAL } from "./CloudSignIn"
import { actorSharedState } from "../ActorBindings"
/*
 * The workspaces seam (lane citc, ADR 0002): the persistent cloud computers
 * behind the `/api/cloud/*` proxy.
 *
 *   GET    /api/user/workspaces                          — the per-user list
 *   GET    /api/repos/{o}/{r}/workspaces                 — one repository's list
 *   POST   /api/repos/{o}/{r}/workspaces                 — create-or-reuse { name?, source_bookmark? }
 *   GET    /api/repos/{o}/{r}/workspaces/{id}
 *   POST   /api/repos/{o}/{r}/workspaces/{id}/suspend|resume
 *   DELETE /api/repos/{o}/{r}/workspaces/{id}
 *   GET    /api/repos/{o}/{r}/workspace/sessions         { workspace_id }
 *   POST   /api/repos/{o}/{r}/workspace/sessions         { workspace_id, cols, rows } — a terminal;
 *                                                         { workspace_id, kind: "lsp", language } is CloudLspClient's (lane L6)
 *   GET    /api/repos/{o}/{r}/workspace/sessions/{id}
 *   POST   /api/repos/{o}/{r}/workspace/sessions/{id}/destroy
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/files?path=            — the Files facet
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/files/content?path=    — one file
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/services               — the Services facet
 *   GET    /api/repos/{o}/{r}/workspaces/{id}/egress?limit=&cursor=  — the Egress facet
 *
 * Lane L3: plue#446 and plue#449 landed, so the DTO's kind, environment,
 * head, ahead/behind, persistence, ssh host and started_at are parsed and the
 * Files, Services and Egress facets read their own routes. Lane L6: plue#505
 * landed, so the DTO's `lsp.languages` and a session's `kind` and `language`
 * are parsed too. Every one of those
 * fields is absent-tolerant: a field the wire omits is null on the row and
 * renders NOTHING — no default, no guess. `bookmarkHead` stays the TARGET
 * BOOKMARK's head from the bookmarks call, labeled as such and separate from
 * the workspace's own `head`.
 *
 * Every act refuses a degraded sign-in with the enable wording, and a bare act
 * resolves its workspace from the active working copy (kind "workspace"), else
 * the single loaded one — never a guess. A workspace still settling (pending,
 * starting) is polled until it settles or is gone; a 404 mid-watch refreshes
 * the repository's list.
 */
import {
  CloudWorkspaceRowSchema,
  parseRepoSelection,
  WORKSPACE_STATUSES
} from "../AppState"
import type {
  Card,
  CloudWorkspaceInput,
  CloudWorkspaceRow,
  EnvironmentImageRow,
  SandboxEgressRow,
  WorkspaceEnvironment,
  WorkspaceFileEntry,
  WorkspaceHead,
  WorkspaceService,
  WorkspaceRecovery
} from "../AppState"
import { canonicalStoredJsonValue } from "../EventValue"
import { CARD_CONTENT_CAP, fileValue, listingValue } from "./FilesSeam"
import { resolveTargetRepo } from "../RepoContext"
import { loadEgressPage, workspaceEgressPath } from "./EgressSeam"
import { workspaceCardFacts } from "../WorkspaceViews"
import { cloudUnreachable, createCloudClient } from "./CloudClient"
import { mayAutoRetry, statedRetryDelayMs, storedRefusal } from "@smthrs/rpc/Refusal"
import type { Refusal, StoredRefusal } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { SeamContext } from "./SeamContext"

export const DEGRADED_WORKSPACE_REFUSAL =
  "This Smithers Cloud sign-in can't use boxes — sign in again to enable them."


/*
 * plue's contract code for a worker that could not start the per-sandbox
 * egress proxy and refused to boot the computer without its credential
 * boundary (internal/microsandbox/worker/server.go). The card says the code
 * itself: a paraphrase would hide which boundary failed.
 */
export const EGRESS_PROXY_UNAVAILABLE = "egress_proxy_unavailable"

/**
 * plue#504: the terminal session POST answers `503 { code: "guest_not_ready" }`
 * with a `Retry-After` header while a vm guest finishes its NixOS
 * activation. The backend sets `RetryAfter: 3` on it.
 */
export const GUEST_NOT_READY = "guest_not_ready"

/**
 * The bounded retry the `guest_not_ready` 503 buys: 30 attempts, which at
 * plue's own `Retry-After: 3` is 90 s — its activation window. Module-level so
 * tests shorten the wait rather than sleeping.
 */
export const terminalSessionRetry = {
  maxAttempts: 30,
  /** Used only when the refusal carried no `Retry-After` this app could read. */
  defaultDelayMs: 3_000
}

export type WorkspaceFacet = "terminal" | "files" | "services" | "egress"

export interface WorkspaceSeam {
  /** `box.list [owner/repo]`: refresh the collection and the tree; a bare call lists the per-user inventory. */
  readonly listWorkspaces: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The silent refresh (sign-in, boot): the collection and tree, no transcript line. */
  readonly refreshWorkspaces: (repo?: string) => Promise<string | void>
  /**
   * `box.open [bookmark] [owner/repo] [--kind container|vm]`:
   * create-or-reuse, render the card, watch until it settles. ADR 0002 — the
   * kind IS the choice; a call that names none leaves plue's own default
   * (`container`) to stand rather than asserting one.
   */
  readonly openWorkspace: (
    bookmark?: string,
    repo?: string,
    kind?: WorkspaceKind,
    snapshot?: string,
    recoveryOf?: string
  ) => Promise<string | void | { readonly value: string }>
  /** `box.view <id>`: re-read one workspace and render its card. */
  readonly viewWorkspace: (workspaceId: string) => Promise<string | void | { readonly value: string }>
  /** `box.terminal [workspaceId]`: open (or re-attach) the workspace's terminal tab. */
  readonly openTerminal: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly suspendWorkspace: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly resumeWorkspace: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** A workspace created FROM a snapshot (the snapshot row's "Fork from"): POST /workspaces { snapshot_id }. */
  readonly listSessions: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  readonly destroySession: (sessionId: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `box.delete <id> <name>`: the workspace's name typed back is the gate — a mismatch refuses, whoever invoked. */
  readonly deleteWorkspace: (workspaceId: string, confirmName: string) => Promise<string | void | { readonly value: string }>
  /** The card's body tab; hidden, card-button scoped. */
  readonly setFacet: ViewAction<[workspaceId: string, facet: WorkspaceFacet]>
  /** `box.files [path] [workspaceId]`: the Files facet at one directory (`""` is the root). */
  readonly listFiles: (path?: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `box.file <path> [workspaceId]`: read one file out of the workspace and render the file card. */
  readonly readFile: (path: string, workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /** `box.services [workspaceId]`: the Services facet's rows. */
  readonly listServices: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
  /**
   * `box.egress [workspaceId] [cursor]`: one page of the egress audit.
   * Without a cursor it replaces the facet's rows; with one it appends the
   * older page the card's "Load older" asked for.
   */
  readonly listEgress: (workspaceId?: string, cursor?: string) => Promise<string | void | { readonly value: string }>
  /** `box.images [owner/repo]`: the environment images a repository has built. */
  readonly listEnvironmentImages: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** Stop owned reads, polls and waits, and cancel pending reads. */
  readonly dispose: () => void
}

/** The three sandbox kinds ADR 0002 names; the option surface offers exactly these. */
export const WORKSPACE_KINDS = ["container", "vm"] as const
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

export interface WorkspaceSeamDeps {
  /** The watch and session-settle poll interval; tests inject ~0. */
  readonly pollMs?: number
  /** The one-command open's readiness poll interval; tests inject 0. */
}

interface SessionRow {
  readonly id: string
  readonly status: string
  readonly createdAt: string | null
  /** plue #505: `terminal` or `lsp`; null on a row that predates the field. */
  readonly kind: string | null
  /** The lsp session's language; null on a terminal. */
  readonly language: string | null
}

/** The auxiliaries a workspace card renders beside the DTO row. */
interface CardAux {
  readonly bookmarkHead: { readonly changeId: string | null; readonly commitId: string | null } | null
  readonly sessions: ReadonlyArray<SessionRow>
  readonly files: ReadonlyArray<WorkspaceFileEntry>
  readonly filesPath: string
  readonly services: ReadonlyArray<WorkspaceService>
  readonly egress: ReadonlyArray<SandboxEgressRow>
  /** plue's next keyset position; an explicit null says the audit is exhausted. */
  readonly egressCursor: string | null
  readonly facet?: WorkspaceFacet | undefined
  /** The attached session; an explicit null override detaches. */
  readonly terminalSessionId?: string | null | undefined
  readonly error?: string | undefined
  /** plue refused an act with `egress_proxy_unavailable`; the card names the code. */
  readonly egressProxyUnavailable?: boolean | undefined
  /**
   * How the terminal session POST refused: the same shape, on the terminal
   * facet (plue#504). A `wait` fault — `guest_not_ready` is one — is the only
   * kind the seam retries on its own, because the server asked it to.
   */
  readonly terminalRefusal?: StoredRefusal | undefined
}

const UNSETTLED: ReadonlySet<string> = new Set(["pending", "starting"])

/** The statuses plue's workspace sessions move through. */
const SESSION_LIVE = "running"

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** How long a new terminal session may take to reach running before the honest refusal. */
const SESSION_SETTLE_ATTEMPTS = 30

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The list a route answers: plue's bare array, its `{ items, next_cursor }` cursor envelope, or one under a named key. */
const arrayOf = (body: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body[key])) return body[key]
  if (isRecord(body) && Array.isArray(body.items)) return body.items
  return []
}

/** Both list routes page at 30 by default and cap at 100 (plue routes/pagination.go, routes/workspace.go). */
const LIST_PAGE_LIMIT = 100
/** 100 rows × 50 pages is far past plue's per-user active-workspace cap; the loop never runs unbounded. */
const MAX_LIST_PAGES = 50

/**
 * The `rel="next"` target of a Link header, or null on the last page. plue
 * writes its list links in the legacy `page`/`per_page` form
 * (setLegacyPaginationHeaders); the per-user route's own parser reads only
 * `cursor`/`limit`, so a next link is re-issued in cursor form — the offset
 * `(page - 1) × per_page` — which both list routes accept.
 */
const nextPageOf = (link: string | null, path: string): string | null => {
  if (link === null) return null
  // The seam's paths omit the `/api` the proxy adds; plue's links carry it.
  const upstreamPath = `/api${path}`
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())
    if (match === null || match[1] === undefined) continue
    let next: URL
    try {
      next = new URL(match[1], "https://cloud.invalid")
    } catch {
      return null
    }
    // A link that leaves the route it paginates is not followed.
    if (next.pathname !== upstreamPath) return null
    const cursor = next.searchParams.get("cursor")
    if (cursor !== null && cursor !== "") return `${path}?limit=${LIST_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
    const page = Number(next.searchParams.get("page"))
    const perPage = Number(next.searchParams.get("per_page") ?? next.searchParams.get("limit"))
    if (!Number.isInteger(page) || page < 2 || !Number.isInteger(perPage) || perPage <= 0) return null
    return `${path}?limit=${LIST_PAGE_LIMIT}&cursor=${(page - 1) * perPage}`
  }
  return null
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const isWorkspaceStatus = (value: unknown): value is CloudWorkspaceInput["status"] =>
  typeof value === "string" && (WORKSPACE_STATUSES as ReadonlyArray<string>).includes(value)

/**
 * The DTO's `head` (plue#446): the workspace's OWN head as the guest last
 * reported it. plue writes empty strings when it has reported none, and an
 * empty head is absent, not a head of "".
 */
const parseHead = (value: unknown): WorkspaceHead | null => {
  if (!isRecord(value)) return null
  const changeId = textOrNull(value.change_id)
  const commitId = textOrNull(value.commit_id)
  return changeId === null && commitId === null ? null : { changeId, commitId }
}

/**
 * The DTO's `environment`: the Nix expression the computer was built from and
 * — lane L3b — the registry `image` a vm workspace actually booted.
 * `image` is empty for a container, and an empty string is absence.
 */
const parseEnvironment = (value: unknown): WorkspaceEnvironment | null => {
  if (!isRecord(value)) return null
  const source = textOrNull(value.source)
  if (source === null) return null
  return {
    source,
    revision: textOrNull(value.revision),
    closureHash: textOrNull(value.closure_hash),
    image: textOrNull(value.image)
  }
}

/**
 * One row of `GET /api/repos/{o}/{r}/environment-images` (lane L3b). plue's
 * `repository_id 0` is the platform base image; an empty `golden_snapshot_id`
 * means the first boot of that closure is a cold registry pull.
 */
const parseEnvironmentImage = (value: unknown): EnvironmentImageRow | null => {
  if (!isRecord(value)) return null
  const rawId = value.id
  const id = typeof rawId === "number" && Number.isInteger(rawId) ? String(rawId) : str(rawId)
  const kind = str(value.kind)
  const source = str(value.source)
  const status = str(value.status)
  if (id === null || kind === null || source === null || status === null) return null
  return {
    id,
    kind,
    source,
    sourceRevision: textOrNull(value.source_revision),
    closureHash: textOrNull(value.closure_hash),
    image: textOrNull(value.image),
    status,
    platformBase: value.repository_id === 0,
    coldPull: textOrNull(value.golden_snapshot_id) === null
  }
}

/** A wire count that must be a whole number to be stated at all. */
const countOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

/**
 * The DTO's `lsp.languages` (plue #505): the languages the workspace relays a
 * language server for. A DTO with no `lsp` object is null — unknown, never
 * an empty list; an `lsp` object with no readable languages is `[]`.
 */
const parseLspLanguages = (value: unknown): Array<string> | null => {
  if (!isRecord(value)) return null
  const languages = value.languages
  if (!Array.isArray(languages)) return []
  return languages.flatMap((entry) => (typeof entry === "string" && entry !== "" ? [entry] : []))
}

/** One workspace row off the wire; malformed rows drop. */
const parseWorkspaceWire = (value: unknown, fallbackRepo?: string): CloudWorkspaceInput | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const repoId = str(value.repo_full_name) ?? fallbackRepo ?? null
  const name = str(value.name) ?? str(value.slug) ?? id
  if (id === null || repoId === null || name === null || !isWorkspaceStatus(value.status)) return null
  return {
    id,
    repoId,
    name,
    sourceSnapshotId: textOrNull(value.snapshot_id),
    targetBookmark: textOrNull(value.target_bookmark),
    status: value.status,
    /* plue#482: why a failed workspace failed, in the provider's own words. */
    failureCode: textOrNull(value.failure_code),
    failureMessage: textOrNull(value.failure_message),
    provisioningStage: textOrNull(value.provisioning_stage),
    suspendedAt: textOrNull(value.suspended_at),
    createdAt: textOrNull(value.created_at),
    kind: textOrNull(value.kind),
    /* RFD-004: the agent session that drove this computer, on a `kind: "agent"` workspace. */
    agentSessionId: textOrNull(value.agent_session_id),
    head: parseHead(value.head),
    ahead: countOrNull(value.ahead),
    behind: countOrNull(value.behind),
    startedAt: textOrNull(value.started_at),
    environment: parseEnvironment(value.environment),
    persistence: textOrNull(value.persistence),
    sshHost: textOrNull(value.ssh_host),
    lspLanguages: parseLspLanguages(value.lsp)
  }
}

/** One row of the workspace file listing (plue#449); a row missing a name drops. */
const parseFileEntry = (value: unknown): WorkspaceFileEntry | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  const type = str(value.type)
  if (name === null || type === null) return null
  const size = value.size
  return {
    name,
    // plue always writes `path`; a row without one is still nameable under the directory the facet asked for.
    path: str(value.path) ?? name,
    type,
    size: typeof size === "number" && Number.isInteger(size) && size >= 0 ? size : null
  }
}

/**
 * One managed-service row (plue#449, and #483's `port` / `url`). Both are
 * `omitempty` on the wire, so a service that publishes neither carries
 * neither and the row states a name and a state alone — an absent port is
 * absence, never a zero.
 */
const parseService = (value: unknown): WorkspaceService | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  const state = str(value.state)
  if (name === null || state === null) return null
  const port = value.port
  return {
    name,
    state,
    port: typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null,
    url: str(value.url)
  }
}

/*
 * One row of GET /api/user/workspaces: plue's UserWorkspaceRow
 * (internal/services/workspace.go — workspace_id, repository_owner,
 * repository_name, workspace_title, state), a switcher row that carries no
 * bookmark, stage, or suspension time. Those stay whatever the collection
 * already knows (the caller merges); they are never invented here.
 */
const parseUserWorkspaceWire = (value: unknown): CloudWorkspaceInput | null => {
  if (!isRecord(value)) return null
  const id = str(value.workspace_id)
  const owner = str(value.repository_owner)
  const repoName = str(value.repository_name)
  const name = str(value.workspace_title) ?? id
  if (id === null || owner === null || repoName === null || name === null || !isWorkspaceStatus(value.state)) return null
  return {
    id,
    repoId: `${owner}/${repoName}`,
    name,
    targetBookmark: null,
    status: value.state,
    /* plue#482: the switcher row states the failure too, so a failed row explains itself in the list. */
    failureCode: textOrNull(value.failure_code),
    failureMessage: textOrNull(value.failure_message),
    provisioningStage: null,
    suspendedAt: null,
    createdAt: textOrNull(value.created_at),
    /*
     * The switcher row carries none of plue#446's header facts — no kind, no
     * head, no ahead/behind, no environment, no persistence, no ssh host, no
     * start time. They are null HERE and the caller restores whatever the
     * collection already knows; nothing is read out of the per-repo DTO's
     * shape, because this route does not answer that shape.
     */
    kind: null,
    agentSessionId: null,
    head: null,
    ahead: null,
    behind: null,
    startedAt: null,
    environment: null,
    persistence: null,
    sshHost: null,
    lspLanguages: null
  }
}

/** One bookmark row off the wire; malformed rows drop. */
const parseBookmark = (value: unknown): { readonly name: string; readonly changeId: string | null; readonly commitId: string | null } | null => {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return null
  return {
    name: value.name,
    changeId: typeof value.target_change_id === "string" ? value.target_change_id : null,
    commitId: typeof value.target_commit_id === "string" ? value.target_commit_id : null
  }
}

/** One session row off the wire; malformed rows drop. */
const parseSession = (value: unknown): (SessionRow & { readonly workspaceId: string | null }) | null => {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const status = str(value.status)
  if (id === null || status === null) return null
  return {
    id,
    status,
    createdAt: textOrNull(value.created_at),
    workspaceId: textOrNull(value.workspace_id),
    kind: textOrNull(value.kind),
    language: textOrNull(value.language)
  }
}

/** A session row as the repository-wide list carries it: it still names its workspace. */
type RepoSessionRow = SessionRow & { readonly workspaceId: string | null }

/*
 * One workspace's rows out of the repository's list. A row that names no
 * workspace belongs to every card — the list route answers for the whole
 * repository and the wire may omit `workspace_id`.
 */
const sessionsOf = (rows: ReadonlyArray<RepoSessionRow>, workspaceId: string): ReadonlyArray<SessionRow> =>
  rows.filter((row) => row.workspaceId === null || row.workspaceId === workspaceId)

const cardIdOf = (workspaceId: string): string => `workspace-${workspaceId}`

const splitRepo = (repoId: string): { readonly owner: string; readonly name: string } => {
  const [owner = "", name = ""] = repoId.split("/")
  return { owner, name }
}

const WorkspaceObservationSchema = CloudWorkspaceRowSchema.omit({ updatedAt: true, revision: true, recovery: true })

export const createWorkspaceSeam = (ctx: SeamContext, deps: WorkspaceSeamDeps = {}): WorkspaceSeam => {
  const pollMs = deps.pollMs ?? 5_000
  const repoPath = (repoId: string, rest: string): string => {
    const { owner, name } = splitRepo(repoId)
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`
  }

  const { runtime, watching, sleepers, terminalOpenEpochs, lifecycle, workspaceEpochs, recoveryFlights } = actorSharedState(ctx, "workspace", () => {
    const runtime = ManagedRuntime.make(Layer.empty)
    const [watching, sleepers] = Effect.runSync(Effect.all([
      FiberMap.make<string, void>(),
      FiberMap.make<{ readonly workspaceId: string }, void>()
    ]).pipe(Scope.provide(runtime.scope)))
    return {
      runtime, watching, sleepers,
      terminalOpenEpochs: new Map<string, number>(),
      lifecycle: { disposed: false },
      recoveryFlights: new Map<string, Promise<unknown>>(),
      workspaceEpochs: new Map<string, number>()
    }
  })
  const { get, send: sendJson } = createCloudClient(ctx)
  const read = (path: string, label?: string) => Effect.tryPromise({
    try: (signal) => get(path, label, signal), catch: cloudUnreachable
  }).pipe(Effect.catch((failure) => Effect.succeed(failure)))
  const getJson = (path: string, label?: string) => runtime.runPromise(read(path, label)).catch(cloudUnreachable)

  /** The lifetime and authorization captured before an await must still own its answer. */
  const currentOperation = (workspaceId?: string): (() => boolean) => {
    const owner = captureCloudOwner(ctx)
    const epoch = workspaceId === undefined ? undefined : workspaceEpochs.get(workspaceId)
    return () => !lifecycle.disposed && owner()
      && (workspaceId === undefined || (
        ctx.store.collections.cloudWorkspaces.has(workspaceId)
        && workspaceEpochs.get(workspaceId) === epoch
      ))
  }

  /** 5s cadence × 120 = ten minutes, the provisioning ceiling the workspaces spec names. */
  const MAX_WATCH_POLLS = 120

  const sleep = (ms: number, workspaceId: string): Promise<boolean> => {
    if (lifecycle.disposed) return Promise.resolve(false)
    return runtime.runPromiseExit(Effect.flatMap(
      FiberMap.run(sleepers, { workspaceId }, Effect.sleep(ms)), Fiber.join
    )).then(Exit.isSuccess)
  }

  const cancelSleeps = (workspaceId?: string): void => {
    for (const [key] of sleepers) {
      if (workspaceId === undefined || key.workspaceId === workspaceId) runtime.runFork(FiberMap.remove(sleepers, key))
    }
  }

  const dispose = (): void => {
    if (lifecycle.disposed) return
    lifecycle.disposed = true
    void runtime.dispose()
    /* The controller is going away, so no facet can be mounted: the credential goes with it. */
    terminalOpenEpochs.clear()
  }

  /*
   * The two gates every workspace act passes: a definitive signed-in answer,
   * and the scope set — the legacy (degraded) token reads but never acts.
   */
  const gate = (): string | void => {
    if (lifecycle.disposed || ctx.isDisposed?.()) return "The workspace controller is disposed."
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
    if (session.scopes === "degraded") return refuseCloudSignIn(ctx, DEGRADED_WORKSPACE_REFUSAL)
  }

  /*
   * The workspace a bare act means: an explicit id (looked up locally — the
   * id alone cannot route without its repository), else the active working
   * copy when it is a workspace, else the single loaded workspace. Never a
   * guess.
   */
  const resolveWorkspace = (
    workspaceId?: string
  ): { readonly workspace: CloudWorkspaceRow } | { readonly error: string } => {
    const { cloudWorkspaces, workingCopies } = ctx.store.collections
    if (workspaceId !== undefined && workspaceId !== "") {
      const row = cloudWorkspaces.get(workspaceId)
      return row === undefined
        ? { error: `Box ${workspaceId} is not loaded — /box.list refreshes the inventory` }
        : { workspace: row }
    }
    const key = ctx.store.session().activeRepoKey ?? null
    const selection = key === null ? null : parseRepoSelection(key)
    if (selection !== null && selection.copyId !== undefined) {
      const copy = workingCopies.get(selection.copyId)
      if (copy?.kind === "workspace" && copy.workspaceId !== undefined) {
        const row = cloudWorkspaces.get(copy.workspaceId)
        if (row !== undefined) return { workspace: row }
      }
    }
    const all = [...cloudWorkspaces.values()]
    if (all.length === 1) return { workspace: all[0]! }
    if (all.length === 0) {
      return { error: "No box is loaded — /box.open creates one, /box.list refreshes" }
    }
    return { error: `Several boxes are loaded (${all.map((row) => row.id).join(", ")}) — name a box id` }
  }

  /* The repository a snapshot or session act routes through. */
  const resolveRepo = (
    workspaceId?: string
  ): { readonly repo: string; readonly workspaceId?: string } | { readonly error: string } => {
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved
    return { repo: resolved.workspace.repoId, workspaceId: resolved.workspace.id }
  }

  /* ---- the auxiliaries: absent answers, never inventions ---- */

  const loadBookmarkHead = async (
    repoId: string,
    bookmark: string | null
  ): Promise<{ readonly changeId: string | null; readonly commitId: string | null } | null> => {
    if (bookmark === null) return null
    const answer = await getJson(repoPath(repoId, "/bookmarks"))
    if ("error" in answer) return null
    const found = arrayOf(answer.body, "bookmarks")
      .flatMap((entry) => {
        const parsed = parseBookmark(entry)
        return parsed === null ? [] : [parsed]
      })
      .find((entry) => entry.name === bookmark)
    return found === undefined ? null : { changeId: found.changeId, commitId: found.commitId }
  }

  const workspacePath = (repoId: string, workspaceId: string, rest: string): string =>
    repoPath(repoId, `/workspaces/${encodeURIComponent(workspaceId)}${rest}`)

  /** One directory inside the working copy (plue#449); the server's own error when it refuses. */
  const loadFiles = async (
    repoId: string,
    workspaceId: string,
    path: string
  ): Promise<ReadonlyArray<WorkspaceFileEntry> | { readonly error: string }> => {
    const answer = await getJson(`${workspacePath(repoId, workspaceId, "/files")}?path=${encodeURIComponent(path)}`)
    if ("error" in answer) return { error: answer.error }
    return arrayOf(answer.body, "entries").flatMap((entry) => {
      const parsed = parseFileEntry(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /** The workspace's managed services (plue#449). */
  const loadServices = async (
    repoId: string,
    workspaceId: string
  ): Promise<ReadonlyArray<WorkspaceService> | { readonly error: string }> => {
    const answer = await getJson(workspacePath(repoId, workspaceId, "/services"))
    if ("error" in answer) return { error: answer.error }
    return arrayOf(answer.body, "services").flatMap((entry) => {
      const parsed = parseService(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /*
   * The repository's whole session list; null = unread. The route is
   * repository-wide, so a refresh that touches several cards reads it ONCE
   * and selects each card's rows out of the one snapshot.
   */
  const loadRepoSessions = async (repoId: string): Promise<ReadonlyArray<RepoSessionRow> | null> => {
    const answer = await getJson(repoPath(repoId, "/workspace/sessions"))
    if ("error" in answer) return null
    return arrayOf(answer.body, "sessions").flatMap((entry) => {
      const parsed = parseSession(entry)
      return parsed === null ? [] : [parsed]
    })
  }

  /** One workspace's sessions; null = unread. */
  const loadSessions = async (repoId: string, workspaceId: string): Promise<ReadonlyArray<SessionRow> | null> => {
    const rows = await loadRepoSessions(repoId)
    return rows === null ? null : sessionsOf(rows, workspaceId)
  }

  /* ---- the card ---- */

  /*
   * Render one workspace's card: the DTO row plus the auxiliaries. An
   * override wins; otherwise the existing card's value stands, so a status
   * poll never blanks the snapshots the open loaded.
   */
  const workspaceCard = (workspace: CloudWorkspaceInput, overrides: Partial<CardAux> = {}): Card => {
    const id = cardIdOf(workspace.id)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "workspace" ? existing.payload : undefined
    /*
     * The collection is the authority: every act dispatches its DTO before
     * it renders, and a settle poll that landed while an act's auxiliaries
     * were loading has already advanced the row — the card renders THAT,
     * never the act's older answer, so the card and the tree agree.
     */
    const current = ctx.store.collections.cloudWorkspaces.get(workspace.id) ?? workspace
    const payload = {
      ...workspaceCardFacts(current),
      bookmarkHead: overrides.bookmarkHead !== undefined ? overrides.bookmarkHead : prior?.bookmarkHead ?? null,
      sessions: overrides.sessions !== undefined ? [...overrides.sessions] : prior?.sessions ?? [],
      ...(overrides.files !== undefined
        ? { files: [...overrides.files], filesPath: overrides.filesPath ?? "" }
        : prior?.files !== undefined ? { files: prior.files, filesPath: prior.filesPath ?? "" } : {}),
      ...(overrides.services !== undefined
        ? { services: [...overrides.services] }
        : prior?.services !== undefined ? { services: prior.services } : {}),
      ...(overrides.egress !== undefined
        ? { egress: [...overrides.egress], egressCursor: overrides.egressCursor ?? null }
        : prior?.egress !== undefined ? { egress: prior.egress, egressCursor: prior.egressCursor ?? null } : {}),
      ...(overrides.facet !== undefined
        ? { facet: overrides.facet }
        : prior?.facet !== undefined ? { facet: prior.facet } : {}),
      ...(overrides.terminalSessionId !== undefined
        ? overrides.terminalSessionId === null ? {} : { terminalSessionId: overrides.terminalSessionId }
        : prior?.terminalSessionId !== undefined ? { terminalSessionId: prior.terminalSessionId } : {}),
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
      ...(overrides.egressProxyUnavailable === true ? { egressProxyUnavailable: true } : {}),
      ...(overrides.terminalRefusal === undefined ? {} : { terminalRefusal: overrides.terminalRefusal })
    }
    const card: Card = {
      id,
      kind: "workspace",
      title: `${current.name} · ${current.repoId}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    return card
  }
  const renderWorkspace = (workspace: CloudWorkspaceInput, overrides: Partial<CardAux> = {}): void => {
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: workspaceCard(workspace, overrides) })
  }

  /*
   * The failure side of an act: the refusal rides the card too, so it stays
   * visible. A refusal plue coded `egress_proxy_unavailable` names that code
   * as well as the message — the worker refused to boot the computer without
   * its credential boundary, and "service unavailable" alone would hide which
   * boundary failed.
   */
  const recoveryOwner = (): Pick<WorkspaceRecovery, "owner" | "ownerRevision" | "identityOwnerRevision"> | undefined => {
    const cloud = ctx.store.collections.cloudSessions.get("cloud")
    if (cloud?.state !== "signed-in" || cloud.username === null) return undefined
    const identity = ctx.store.collections.identitySessions.get("identity")
    const identityOwnerRevision = identity?.ownerRevision ?? identity?.revision
    return { owner: cloud.username, ownerRevision: cloud.ownerRevision ?? cloud.revision,
      ...(identityOwnerRevision === undefined ? {} : { identityOwnerRevision }) }
  }
  const ownsRecovery = (recovery: WorkspaceRecovery): boolean => {
    const owner = recoveryOwner()
    return owner !== undefined && owner.owner === recovery.owner && owner.ownerRevision === recovery.ownerRevision
      && owner.identityOwnerRevision === recovery.identityOwnerRevision
  }
  const writeRecovery = async (oldId: string, recovery: WorkspaceRecovery): Promise<void> => {
    const row = ctx.store.collections.cloudWorkspaces.get(oldId)
    if (row === undefined || !ownsRecovery(recovery) || lifecycle.disposed) return
    await ctx.dispatch({ type: "workspace.updated", actor: "system",
      workspace: { ...row, recovery } }).isPersisted.promise
  }

  const failOnCard = (
    workspace: CloudWorkspaceInput,
    refusal: string | { readonly error: string; readonly code: string | null; readonly refusal?: Refusal; readonly details?: unknown }
  ): string | Promise<string> => {
    if (typeof refusal !== "string" && refusal.refusal?.rawCode === "plan_limit_exceeded") {
      return renderPlanLimit(ctx.store, refusal.refusal, ctx.checkout ?? false, ctx.actor())
    }
    const error = typeof refusal === "string" ? refusal : refusal.error
    if (typeof refusal !== "string" && refusal.code === "workspace_vm_missing" && isRecord(refusal.details)
      && refusal.details.workspace_id === workspace.id && refusal.details.create_fresh === true) {
      const owner = recoveryOwner()
      if (owner !== undefined) {
        const existing = ctx.store.collections.cloudWorkspaces.get(workspace.id)?.recovery
        ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: {
          ...workspace, recovery: { ...owner, createFresh: true,
            ...(typeof refusal.details.snapshot_id === "string" && refusal.details.snapshot_id !== ""
              ? { snapshotId: refusal.details.snapshot_id } : {}),
            ...(existing !== undefined && ownsRecovery(existing) && existing.request !== undefined ? { request: existing.request } : {}) }
        } })
      }
    }
    const proxyGone = typeof refusal !== "string" && refusal.code === EGRESS_PROXY_UNAVAILABLE
    renderWorkspace(workspace, { error, ...(proxyGone ? { egressProxyUnavailable: true } : {}) })
    /*
     * The line that goes back to the transcript, the toast and the model: the
     * code first (the anchor the agent boundary reads), then plue's own words,
     * then the one sentence saying whose fault it was. A bare string caller
     * has no refusal to classify and keeps its sentence unchanged.
     */
    const classified = typeof refusal === "string" ? undefined : refusal.refusal
    return classified === undefined ? error : refusalSentence(classified)
  }

  /* ---- the list load (listWorkspaces, delete's aftermath, a 404 mid-watch) ---- */

  /** One page of a list route: its body and the next page's seam path (cursor form), or the honest error. */
  const getListPage = (
    pagePath: string,
    routePath: string
  ): Effect.Effect<{ readonly body: unknown; readonly next: string | null; readonly total: number | null } | { readonly error: string }> => Effect.gen(function*() {
    const answer = yield* read(pagePath, routePath)
    if ("error" in answer) return answer
    const { response } = answer
    const totalHeader = response.headers.get("x-total-count")
    const total = Number(totalHeader)
    return {
      body: answer.body,
      next: nextPageOf(response.headers.get("link"), routePath),
      total: totalHeader !== null && Number.isInteger(total) && total >= 0 ? total : null
    }
  })

  /*
   * The whole list, every page: `?limit=100` and the Link header's next page
   * until it is exhausted. A body that answered rows Smithers could not read
   * is an error, never an empty scope replace that would drop every loaded
   * workspace and its tree row.
   */
  const loadListEffect = (
    repo?: string,
    current = currentOperation()
  ): Effect.Effect<ReadonlyArray<CloudWorkspaceInput> | string> => Effect.gen(function*() {
    if (!current()) return SIGN_OUT_REFUSAL
    const scope = repo === undefined ? {} : { repoId: repo }
    const requestId = crypto.randomUUID()
    ctx.dispatch({ type: "workspaces.list.started", actor: "system", requestId, ...scope })
    const latest = (): boolean => {
      const observations = ctx.store.collections.cloudSessions.get("cloud")?.workspaceLists ?? []
      const active = observations.find(row => row.scope === (repo ?? "*"))
      return active?.requestId === requestId && !observations.some(row =>
        row.revision > active.revision && (repo === undefined || row.scope === "*" || row.scope === repo))
    }
    const fail = (error: string): string => {
      if (current()) ctx.dispatch({ type: "workspaces.list.failed", actor: "system", requestId, ...scope, error })
      return error
    }
    const path = repo === undefined ? "/user/workspaces" : repoPath(repo, "/workspaces")
    const raw: Array<unknown> = []
    let next: string | null = `${path}?limit=${LIST_PAGE_LIMIT}`
    const seen = new Set<string>()
    for (let page = 0; next !== null && page < MAX_LIST_PAGES; page += 1) {
      if (seen.has(next)) break
      seen.add(next)
      if (!current()) return SIGN_OUT_REFUSAL
      if (!latest()) return fail("A newer box list was requested. Try again.")
      const answer: Effect.Success<ReturnType<typeof getListPage>> = yield* getListPage(next, path)
      if (!current()) return SIGN_OUT_REFUSAL
      if (!latest()) return fail("A newer box list was requested. Try again.")
      if ("error" in answer) return fail(answer.error)
      const rows = arrayOf(answer.body, "workspaces")
      raw.push(...rows)
      if (rows.length === 0 || (answer.total !== null && raw.length >= answer.total)) break
      next = answer.next
    }
    const parsed = raw.flatMap((entry) => {
      const row = repo === undefined
        ? parseUserWorkspaceWire(entry) ?? parseWorkspaceWire(entry)
        : parseWorkspaceWire(entry, repo)
      return row === null ? [] : [row]
    })
    if (raw.length > 0 && parsed.length === 0) {
      return fail(`Smithers Cloud answered ${raw.length} box row${raw.length === 1 ? "" : "s"} in a shape Smithers can't read — the loaded boxes were kept.`)
    }
    /*
     * The per-user row is a switcher row: no bookmark, no stage, no
     * suspension time. What the collection already holds for a workspace
     * stands where the row is silent; a status that moved on drops the
     * fields that only made sense in the old one.
     */
    const workspaces = repo === undefined
      ? parsed.map((row) => {
        const known = ctx.store.collections.cloudWorkspaces.get(row.id)
        if (known === undefined) return row
        return {
          ...row,
          targetBookmark: known.targetBookmark,
          provisioningStage: UNSETTLED.has(row.status) ? known.provisioningStage : null,
          suspendedAt: row.status === "suspended" ? known.suspendedAt : null,
          createdAt: row.createdAt ?? known.createdAt,
          /*
           * plue#446's header facts are not in the switcher row. What the
           * per-repo DTO already taught the collection stands — except
           * `startedAt`, which only describes a running VM: a status that
           * left "running" drops it rather than reporting an uptime for a
           * computer that is no longer up.
           */
          kind: known.kind ?? null,
          agentSessionId: known.agentSessionId ?? null,
          head: known.head ?? null,
          ahead: known.ahead ?? null,
          behind: known.behind ?? null,
          startedAt: row.status === "running" ? known.startedAt ?? null : null,
          environment: known.environment ?? null,
          persistence: known.persistence ?? null,
          sshHost: known.sshHost ?? null,
          lspLanguages: known.lspLanguages ?? null
        }
      })
      : parsed
    ctx.dispatch({
      type: "workspaces.loaded",
      actor: "system",
      requestId,
      workspaces,
      ...(repo === undefined ? {} : { repoId: repo })
    })
    return workspaces
  })
  const loadList = (...args: Parameters<typeof loadListEffect>) => runtime.runPromise(loadListEffect(...args)).catch((cause) => {
    if (lifecycle.disposed) return SIGN_OUT_REFUSAL
    throw cause
  })

  /** Polls compare durable facts, excluding local observation timestamps and revisions. */
  const persistWorkspaceObservation = async (workspace: CloudWorkspaceInput): Promise<void> => {
    const committed = ctx.store.committedWorkspace(workspace.id)
    const current = ctx.store.collections.cloudWorkspaces.get(workspace.id)
    const value = canonicalStoredJsonValue(WorkspaceObservationSchema.parse(workspace))
    if (committed !== undefined && current !== undefined &&
      canonicalStoredJsonValue(WorkspaceObservationSchema.parse(committed)) === value &&
      canonicalStoredJsonValue(WorkspaceObservationSchema.parse(current)) === value) return
    await ctx.dispatch({ type: "workspace.updated", actor: "system", workspace }).isPersisted.promise
  }

  /* ---- the settle watch ---- */

  /*
   * Poll one settling workspace until it leaves pending/starting (or is
   * gone). A failed poll is not a fact — the watch simply tries again; a 404
   * IS a fact, and the honest answer is to re-read the repository's list.
   */
  const poll = (workspaceId: string, current: () => boolean) => Effect.gen(function*() {
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined || !current()) return false
    const answer = yield* read(repoPath(row.repoId, `/workspaces/${encodeURIComponent(workspaceId)}`))
    if (!current()) return false
    if (answer.status === 404) {
      yield* loadListEffect(row.repoId, current)
      return false
    }
    if (!("error" in answer)) {
      const parsed = parseWorkspaceWire(answer.body, row.repoId)
      if (parsed !== null) {
        yield* Effect.promise(() => persistWorkspaceObservation(parsed))
        if (!current()) return false
        if (!UNSETTLED.has(parsed.status)) return false
      }
    }
    return true
  }).pipe(
    Effect.repeat({ times: MAX_WATCH_POLLS - 1, while: (pending) => pending, schedule: Schedule.spaced(pollMs) }),
    Effect.asVoid
  )

  const watch = (workspaceId: string): void => {
    if (lifecycle.disposed) return
    runtime.runFork(FiberMap.run(watching, workspaceId, poll(workspaceId, currentOperation(workspaceId)), { onlyIfMissing: true }))
  }

  /* ---- the acts ---- */

  const refreshWorkspaces: WorkspaceSeam["refreshWorkspaces"] = async (repo) => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return
    const current = currentOperation()
    const loaded = await loadList(repo === undefined || repo === "" ? undefined : repo, current)
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof loaded !== "string") reconnectRecovery()
    return typeof loaded === "string" ? loaded : undefined
  }

  const listWorkspaces: WorkspaceSeam["listWorkspaces"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = repo === undefined || repo === "" ? undefined : resolveTargetRepo(ctx.store, repo)
    if (target !== undefined && "error" in target) return target.error
    const scope = target !== undefined && "repo" in target ? target.repo : undefined
    const current = currentOperation()
    const loaded = await loadList(scope, current)
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof loaded === "string") return loaded
    reconnectRecovery()
    const listing = loaded.length === 0
      ? scope === undefined
        ? "No boxes."
        : `No boxes on ${scope}.`
      : loaded
        .map((workspace) =>
          `${workspace.name} (${workspace.id}) · ${workspace.status} · ${workspace.repoId}${
            workspace.targetBookmark === null ? "" : `@${workspace.targetBookmark}`
          }`)
        .join("\n")
    ctx.dispatch({ type: "message.appended", actor: "system", text: listing })
    return { value: listing }
  }

  const openWorkspaceNow = async (bookmark?: string, repo?: string, kind?: WorkspaceKind, snapshot?: string,
    recovery?: { readonly oldId: string; readonly facts: WorkspaceRecovery }): Promise<string | void | { readonly value: string }> => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const requestedSelection = ctx.store.session().activeRepoKey
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    /*
     * The source bookmark: the explicit one, else the repository's head
     * bookmark (the same default the create route applies). An unnamed
     * source is omitted, never invented.
     */
    const repoRow = ctx.store.collections.repositories.get(target.repo)
    const source = recovery === undefined
      ? bookmark === undefined || bookmark === "" ? repoRow?.head?.bookmark ?? undefined : bookmark
      : recovery.facts.request!.bookmark ?? undefined
    /*
     * ADR 0002: three sandbox kinds share one option surface and the kind IS
     * the choice. A call that named one sends it; a call that named none
     * sends none, so plue's own default (`container`) applies rather than the
     * app asserting a kind the human never picked. There is no environment or
     * image field — that default stands.
     */
    const created = await sendJson("POST", repoPath(target.repo, "/workspaces"), {
      ...(source === undefined ? {} : { source_bookmark: source }),
      ...(kind === undefined ? {} : { kind }),
      ...(snapshot === undefined ? {} : { snapshot_id: snapshot }),
      ...(recovery === undefined ? {} : { name: recovery.facts.request!.name })
    })
    /*
     * The code travels in the answer itself: a creation refused for the
     * missing egress proxy names `egress_proxy_unavailable`, exactly, beside
     * the server's own message.
     *
     * The refusal ALSO lands, verbatim, on the card whose create affordance
     * was pressed. That affordance only exists on a FAILED workspace's card
     * (the three-kind row), so the refusal goes to exactly those cards on this
     * repository and nowhere else — a running workspace's card said nothing
     * about this create and must not start now. plue's 409 for a kind whose
     * base image is still registering ("no NixOS environment image is
     * registered for kind vm") is the honest state of the system, so it
     * reads as plue wrote it.
     */
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in created) {
      if (recovery !== undefined) {
        const facts = recovery.facts
        await writeRecovery(recovery.oldId, { ...facts,
          ...(created.code === "snapshot_not_found" ? { snapshotId: undefined } : {}),
          request: { ...facts.request!, state: created.status === null || created.status >= 500 ? "requested" : "failed", error: created.error } })
      }
      if (created.refusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, created.refusal, ctx.checkout ?? false, ctx.actor())
      for (const row of ctx.store.collections.cloudWorkspaces.values()) {
        if (row.repoId !== target.repo || row.status !== "failed") continue
        if (ctx.store.collections.cards.get(cardIdOf(row.id)) === undefined) continue
        renderWorkspace(row, { error: created.error })
      }
      /* One sentence for every refusal: the code, plue's own words, then whose fault it was. */
      return refusalSentence(created.refusal)
    }
    const workspace = parseWorkspaceWire(created.body, target.repo)
    if (workspace === null) {
      if (recovery !== undefined) await writeRecovery(recovery.oldId, { ...recovery.facts,
        request: { ...recovery.facts.request!, error: "Creation not confirmed." } })
      return `Smithers Cloud's answer for the new box on ${target.repo} was malformed.`
    }
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace })
    // Opening a computer also makes it the target of subsequent coding runs.
    // A slow create must not pull the user back after they chose another repo.
    if (ctx.store.session().activeRepoKey === requestedSelection) {
      ctx.dispatch({ type: "repo.selected", actor: ctx.actor(), id: `${workspace.repoId}#workspace:${workspace.id}` })
    }
    if (recovery !== undefined) {
      await writeRecovery(recovery.oldId, { ...recovery.facts,
        request: { ...recovery.facts.request!, state: "running", workspaceId: workspace.id } })
      renderWorkspace(workspace)
      return finishRecovery(recovery.oldId, workspace.id, accountCurrent)
    }
    if (UNSETTLED.has(workspace.status)) watch(workspace.id)
    const [bookmarkHead, sessions] = await Promise.all([
      loadBookmarkHead(workspace.repoId, workspace.targetBookmark),
      loadSessions(workspace.repoId, workspace.id)
    ])
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    renderWorkspace(workspace, {
      bookmarkHead,
      ...(sessions === null ? {} : { sessions })
    })
    return {
      value: `Box "${workspace.name}" (${workspace.id}) is ${workspace.status} on ${workspace.repoId}${
        workspace.targetBookmark === null ? "" : `@${workspace.targetBookmark}`
      } — the card tracks it.`
    }
  }

  const recoverySourceMatches = (row: CloudWorkspaceInput, request: NonNullable<WorkspaceRecovery["request"]>): boolean =>
    // null records an omitted source: the backend selects its repository default.
    (request.bookmark === null || row.targetBookmark === request.bookmark)
      && (request.kind === undefined || row.kind === request.kind)
      && (request.snapshotId === undefined ? row.sourceSnapshotId === null : row.sourceSnapshotId === request.snapshotId)
  const finishRecovery = async (oldId: string, newId: string, current: () => boolean): Promise<string | { readonly value: string }> => {
    if (!current()) return SIGN_OUT_REFUSAL
    const row = ctx.store.collections.cloudWorkspaces.get(newId)
    const initialFacts = ctx.store.collections.cloudWorkspaces.get(oldId)?.recovery
    if (row !== undefined && initialFacts?.request !== undefined && ownsRecovery(initialFacts)
      && !recoverySourceMatches(row, initialFacts.request)) {
      await writeRecovery(oldId, { ...initialFacts, request: { ...initialFacts.request, error: "Creation source changed." } })
      return "Creation source changed."
    }
    if (row !== undefined && UNSETTLED.has(row.status)) {
      await runtime.runPromise(Effect.flatMap(FiberMap.run(watching, newId, poll(newId, current), { onlyIfMissing: true }), Fiber.join))
    }
    if (!current()) return SIGN_OUT_REFUSAL
    const facts = ctx.store.collections.cloudWorkspaces.get(oldId)?.recovery
    const settled = ctx.store.collections.cloudWorkspaces.get(newId)
    if (facts?.request === undefined || facts.request.workspaceId !== newId || !ownsRecovery(facts)) return SIGN_OUT_REFUSAL
    if (settled !== undefined && !recoverySourceMatches(settled, facts.request)) {
      await writeRecovery(oldId, { ...facts, request: { ...facts.request, error: "Creation source changed." } })
      return "Creation source changed."
    }
    const error = settled?.status === "running" ? undefined : settled?.failureMessage ?? "Creation not confirmed."
    await writeRecovery(oldId, { ...facts,
      ...(settled?.failureCode === "snapshot_not_found" ? { snapshotId: undefined } : {}),
      request: { ...facts.request, state: error === undefined ? "completed" : settled === undefined || UNSETTLED.has(settled.status) ? "running" : "failed", ...(error === undefined ? {} : { error }) } })
    if (settled !== undefined) renderWorkspace(settled)
    return error === undefined ? { value: "Box ready." } : error
  }
  const launchRecovery = (oldId: string, work: () => Promise<unknown>, current: () => boolean): void => {
    if (recoveryFlights.has(oldId)) return
    const flight = (ctx.withToast === undefined ? Promise.resolve().then(work)
      : ctx.withToast(`box.recreate:${oldId}`, "Creating box…", "Box ready", work, false, current, cardIdOf(oldId)))
      .catch(error => { ctx.report?.("workspace recreation", error) })
      .finally(() => { if (recoveryFlights.get(oldId) === flight) recoveryFlights.delete(oldId) })
    recoveryFlights.set(oldId, flight)
  }
  const reconnectRecovery = (): void => {
    for (const old of ctx.store.collections.cloudWorkspaces.values()) {
      const facts = old.recovery
      const request = facts?.request
      if (facts === undefined || request === undefined || !ownsRecovery(facts)
        || !["requested", "running"].includes(request.state) || recoveryFlights.has(old.id)) continue
      // An uncertain POST is never repeated. Reconcile its retained identity
      // against the owner-scoped list, then join the ordinary completion watch.
      const candidate = request.workspaceId === undefined
        ? [...ctx.store.collections.cloudWorkspaces.values()].find(row => row.id !== old.id && row.repoId === old.repoId
          && row.name === request.name)
        : ctx.store.collections.cloudWorkspaces.get(request.workspaceId)
      if (candidate === undefined) continue
      const current = currentOperation(old.id)
      launchRecovery(old.id, async () => {
        let confirmed: CloudWorkspaceInput = candidate
        if (request.workspaceId === undefined && candidate.sourceSnapshotId === undefined) {
          const answer = await getJson(repoPath(old.repoId, `/workspaces/${encodeURIComponent(candidate.id)}`))
          if (!current()) return SIGN_OUT_REFUSAL
          const parsed = "error" in answer ? null : parseWorkspaceWire(answer.body, old.repoId)
          if (parsed === null || parsed.id !== candidate.id || parsed.name !== request.name || !recoverySourceMatches(parsed, request)) {
            await writeRecovery(old.id, { ...facts, request: { ...request, error: "Creation not confirmed." } })
            return "Creation not confirmed."
          }
          confirmed = parsed
          await persistWorkspaceObservation(parsed)
        }
        if (!current()) return SIGN_OUT_REFUSAL
        if (!recoverySourceMatches(confirmed, request)) {
          await writeRecovery(old.id, { ...facts, request: { ...request, error: "Creation source changed." } })
          return "Creation source changed."
        }
        await writeRecovery(old.id, { ...facts, request: { ...request, state: "running", workspaceId: confirmed.id } })
        renderWorkspace(confirmed)
        return finishRecovery(old.id, confirmed.id, current)
      }, current)
    }
  }
  const openWorkspace: WorkspaceSeam["openWorkspace"] = async (bookmark, repo, kind, snapshot, recoveryOf) => {
    if (recoveryOf === undefined) return openWorkspaceNow(bookmark, repo, kind, snapshot)
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const old = ctx.store.collections.cloudWorkspaces.get(recoveryOf)
    const facts = old?.recovery
    if (old === undefined || facts === undefined || !ownsRecovery(facts) || old.repoId !== repo
      || (snapshot === undefined ? !facts.createFresh : facts.snapshotId !== snapshot)) return "Recovery is unavailable. Refresh this box."
    if (facts.request !== undefined && ["requested", "running"].includes(facts.request.state)) {
      reconnectRecovery()
      return { value: "Creation requested." }
    }
    const id = crypto.randomUUID()
    const request: NonNullable<WorkspaceRecovery["request"]> = { id, name: `recovery-${id}`, actor: ctx.actor(),
      bookmark: old.targetBookmark ?? ctx.store.collections.repositories.get(old.repoId)?.head?.bookmark ?? null,
      ...(kind === undefined ? {} : { kind }), state: "requested", ...(snapshot === undefined ? {} : { snapshotId: snapshot }) }
    const next = { ...facts, request }
    const persisted = ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: { ...old, recovery: next } }).isPersisted.promise
    const current = currentOperation(old.id)
    launchRecovery(old.id, async () => {
      await persisted
      if (!current()) return SIGN_OUT_REFUSAL
      return openWorkspaceNow(request.bookmark ?? undefined, old.repoId, kind, request.snapshotId, { oldId: old.id, facts: next })
    }, current)
    return { value: "Creation requested." }
  }

  const viewWorkspace: WorkspaceSeam["viewWorkspace"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const current = currentOperation(workspace.id)
    const answer = await getJson(repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in answer) return failOnCard(workspace, answer)
    const fresh = parseWorkspaceWire(answer.body, workspace.repoId)
    if (fresh === null) return `Smithers Cloud's answer for box ${workspace.id} was malformed.`
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fresh })
    if (UNSETTLED.has(fresh.status)) watch(fresh.id)
    const [bookmarkHead, sessions] = await Promise.all([
      loadBookmarkHead(fresh.repoId, fresh.targetBookmark),
      loadSessions(fresh.repoId, fresh.id)
    ])
    if (!current()) return SIGN_OUT_REFUSAL
    renderWorkspace(fresh, {
      bookmarkHead,
      ...(sessions === null ? {} : { sessions })
    })
    return { value: `Box "${fresh.name}" (${fresh.id}) is ${fresh.status} — the card is current.` }
  }

  /* Suspend and resume share everything but the verb. */
  const transitionWorkspace = async (
    verb: "suspend" | "resume",
    workspaceId?: string
  ): Promise<string | void | { readonly value: string }> => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const accountCurrent = currentOperation()
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const answer = await sendJson("POST", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}/${verb}`))
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    if ("error" in answer) return failOnCard(workspace, answer)
    /*
     * The act's body is the updated workspace when plue writes one; when it
     * does not, the truth is a re-read, never an assumed status.
     */
    let fresh = parseWorkspaceWire(answer.body, workspace.repoId)
    if (fresh === null) {
      const reread = await getJson(repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
      if (!accountCurrent()) return SIGN_OUT_REFUSAL
      if ("error" in reread) {
        await loadList(workspace.repoId, accountCurrent)
        if (!accountCurrent()) return SIGN_OUT_REFUSAL
        return `Box "${workspace.name}" (${workspace.id}) ${verb}ed, but its new state could not be read — the list was refreshed.`
      }
      fresh = parseWorkspaceWire(reread.body, workspace.repoId)
      if (fresh === null) {
        await loadList(workspace.repoId, accountCurrent)
        if (!accountCurrent()) return SIGN_OUT_REFUSAL
        return `Box "${workspace.name}" (${workspace.id}) ${verb}ed, but its answer was malformed — the list was refreshed.`
      }
    }
    if (!accountCurrent()) return SIGN_OUT_REFUSAL
    ctx.dispatch({ type: "workspace.updated", actor: "system", workspace: fresh })
    if (UNSETTLED.has(fresh.status)) watch(fresh.id)
    renderWorkspace(fresh)
    return { value: `Box "${fresh.name}" (${fresh.id}) is ${fresh.status}.` }
  }

  const listSessions: WorkspaceSeam["listSessions"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const current = currentOperation(workspace.id)
    const sessions = await loadSessions(workspace.repoId, workspace.id)
    if (!current()) return SIGN_OUT_REFUSAL
    if (sessions === null) return `The sessions of box ${workspace.id} couldn't be read right now.`
    renderWorkspace(workspace, { sessions })
    return {
      value: sessions.length === 0
        ? `Box "${workspace.name}" (${workspace.id}) has no sessions.`
        : `Box "${workspace.name}" (${workspace.id}) sessions: ${
          sessions.map((session) => `${session.id} (${session.status})`).join(", ")
        }.`
    }
  }

  const destroySession: WorkspaceSeam["destroySession"] = async (sessionId, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveRepo(workspaceId)
    if ("error" in resolved) return resolved.error
    const current = currentOperation(resolved.workspaceId)
    const destroyed = await sendJson(
      "POST",
      repoPath(resolved.repo, `/workspace/sessions/${encodeURIComponent(sessionId)}/destroy`)
    )
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in destroyed) return destroyed.error
    /*
     * Destroyed is a fact the tab and the card learn together: the terminal
     * tab attached to the session closes and the card stops pointing at it
     * in one transaction (the facet re-offers to open one rather than claim
     * a dead attachment); the session lists refresh after.
     */
    ctx.dispatch({ type: "workspace.session.destroyed", actor: ctx.actor(), sessionId })
    /* One repository-wide read is the refresh for every card in it. */
    const rows = await loadRepoSessions(resolved.repo)
    if (!current()) return SIGN_OUT_REFUSAL
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind !== "workspace" || card.payload.repo !== resolved.repo) continue
      const row = ctx.store.collections.cloudWorkspaces.get(card.payload.workspaceId)
      if (row === undefined) continue
      renderWorkspace(row, rows === null ? {} : { sessions: sessionsOf(rows, row.id) })
    }
    return { value: `Session ${sessionId} is destroyed.` }
  }

  const deleteWorkspace: WorkspaceSeam["deleteWorkspace"] = async (workspaceId, confirmName) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    /*
     * The typed-name gate lives HERE, not only in the card's chrome: a slash,
     * an agent's confirmed invocation, and the card's button all arrive with
     * the name the invoker typed, and only the workspace's own name deletes.
     */
    if (confirmName.trim() !== workspace.name) {
      return `Deleting "${workspace.name}" (${workspace.id}) needs its name typed back exactly — /box.delete ${workspace.id} ${workspace.name}.`
    }
    const current = currentOperation(workspace.id)
    const deleted = await sendJson("DELETE", repoPath(workspace.repoId, `/workspaces/${encodeURIComponent(workspace.id)}`))
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in deleted) return failOnCard(workspace, deleted)
    /*
     * Gone is a fact: the card, the collection row, its tree copy, and its
     * terminal tabs leave in one transaction; the list refresh after it
     * re-reads the repository's truth.
     */
    /* Invalidate reads and both session phases before removing the workspace. */
    workspaceEpochs.set(workspace.id, (workspaceEpochs.get(workspace.id) ?? 0) + 1)
    terminalOpenEpochs.set(workspace.id, (terminalOpenEpochs.get(workspace.id) ?? 0) + 1)
    runtime.runFork(FiberMap.remove(watching, workspace.id))
    cancelSleeps(workspace.id)
    /* A retry loop for a computer that no longer exists has nothing to mint. */
    ctx.dispatch({ type: "workspace.deleted", actor: ctx.actor(), workspaceId: workspace.id })
    const owner = captureCloudOwner(ctx)
    const loaded = await loadList(workspace.repoId, owner)
    if (!owner()) return SIGN_OUT_REFUSAL
    if (typeof loaded === "string") return loaded
    return { value: `Box "${workspace.name}" (${workspace.id}) is deleted.` }
  }

  /*
   * The Files facet at one directory (plue#449). The listing REPLACES what
   * the card held for the old path — a stale listing under a new path would
   * describe a directory that was never read.
   */
  const renderFiles = async (
    workspace: CloudWorkspaceRow,
    path: string,
    facet?: WorkspaceFacet
  ): Promise<string | void> => {
    const current = currentOperation(workspace.id)
    const files = await loadFiles(workspace.repoId, workspace.id, path)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in files) {
      renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), error: files.error })
      return files.error
    }
    renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), files, filesPath: path })
  }

  const renderServices = async (workspace: CloudWorkspaceRow, facet?: WorkspaceFacet): Promise<string | void> => {
    const current = currentOperation(workspace.id)
    const services = await loadServices(workspace.repoId, workspace.id)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in services) {
      renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), error: services.error })
      return services.error
    }
    renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), services })
  }

  /*
   * One page of the egress audit. A cursor APPENDS (the card's "Load older"
   * walks backwards through plue's keyset); no cursor replaces, so re-opening
   * the facet re-reads the newest page instead of stacking duplicates.
   */
  const renderEgress = async (
    workspace: CloudWorkspaceRow,
    cursor?: string,
    facet?: WorkspaceFacet
  ): Promise<string | void> => {
    const current = currentOperation(workspace.id)
    const page = await loadEgressPage(ctx, workspaceEgressPath(workspace.repoId, workspace.id), cursor)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in page) {
      renderWorkspace(workspace, { ...(facet === undefined ? {} : { facet }), error: page.error })
      return page.error
    }
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const held = card?.kind === "workspace" ? card.payload.egress ?? [] : []
    renderWorkspace(workspace, {
      ...(facet === undefined ? {} : { facet }),
      egress: cursor === undefined || cursor === "" ? page.rows : [...held, ...page.rows],
      egressCursor: page.nextCursor
    })
  }

  const setFacet = preparedView(ctx, (workspaceId: string, facet: WorkspaceFacet) => {
    if (gate() !== undefined) return SIGN_OUT_REFUSAL
    const current = currentOperation(workspaceId)
    const row = ctx.store.collections.cloudWorkspaces.get(workspaceId)
    if (row === undefined) return `Box ${workspaceId} is not loaded — /box.list refreshes the inventory`
    const existing = ctx.store.collections.cards.get(cardIdOf(row.id))
    const path = existing?.kind === "workspace" ? existing.payload.filesPath ?? "" : ""
    const placeholder = workspaceCard(row, { facet })
    return { id: placeholder.id, title: placeholder.title, pane: workspaceId, placeholder,
      key: JSON.stringify([placeholder.id, facet, facet === "files" ? path : undefined]),
      project: card => {
        if (card.kind !== "workspace") return card
        const p = card.payload
        // Preserve current lifecycle; only the requested facet was prefetched.
        return workspaceCard(row, { facet, ...(facet === "files" ? { files: p.files, filesPath: p.filesPath }
          : facet === "services" ? { services: p.services } : facet === "egress" ? { egress: p.egress, egressCursor: p.egressCursor }
          : facet === "terminal" ? { sessions: p.sessions.map(session => ({ ...session, kind: session.kind ?? null, language: session.language ?? null })) } : {}) })
      },
      before: async () => {
        if (!current()) return SIGN_OUT_REFUSAL

      },
      read: async () => {
        if (!current()) return SIGN_OUT_REFUSAL
        let extra: Partial<CardAux> = { facet }
        if (facet === "terminal") {
          const sessions = await loadSessions(row.repoId, row.id)
          if (sessions === null) return "Box sessions couldn't be loaded. Try again."
          extra = { facet, sessions }
        } else if (facet === "files") {
          const files = await loadFiles(row.repoId, row.id, path)
          if ("error" in files) return files.error
          extra = { facet, files, filesPath: path }
        } else if (facet === "services") {
          const services = await loadServices(row.repoId, row.id)
          if ("error" in services) return services.error
          extra = { facet, services }
        } else if (facet === "egress") {
          const page = await loadEgressPage(ctx, workspaceEgressPath(row.repoId, row.id))
          if ("error" in page) return page.error
          extra = { facet, egress: page.rows, egressCursor: page.nextCursor }
        }
        if (!current()) return SIGN_OUT_REFUSAL
        return { card: workspaceCard(row, extra) }
      },
    }
  })

  const listFiles: WorkspaceSeam["listFiles"] = async (path, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    // `/` is how a human spells the working copy's root; plue's own spelling is the empty path.
    const at = path === undefined || path === "/" ? "" : path
    const current = currentOperation(workspace.id)
    const failure = await renderFiles(workspace, at, "files")
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof failure === "string") return failure
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const files = card?.kind === "workspace" ? card.payload.files ?? [] : []
    return {
      value: listingValue(`"${workspace.name}" (${workspace.id})`, at, files.map((file) => ({
        name: file.name,
        kind: file.type === "dir" ? "dir" : "file"
      })))
    }
  }

  const readFile: WorkspaceSeam["readFile"] = async (path, workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const current = currentOperation(workspace.id)
    const answer = await getJson(
      `${workspacePath(workspace.repoId, workspace.id, "/files/content")}?path=${encodeURIComponent(path)}`
    )
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in answer) return failOnCard(workspace, answer)
    const body = isRecord(answer.body) ? answer.body : null
    const content = body === null || typeof body.content !== "string" ? null : body.content
    if (content === null) return `Smithers Cloud's answer for ${path} in ${workspace.id} was malformed.`
    /*
     * plue answers `encoding: "base64"` when the bytes are not UTF-8. The
     * file card states that instead of printing them — the same contract the
     * repository file card follows.
     */
    const binary = body?.encoding === "base64"
    const text = binary ? "" : content.slice(0, CARD_CONTENT_CAP)
    const truncated = !binary && (body?.truncated === true || content.length > CARD_CONTENT_CAP)
    const id = `workspace-file-${workspace.id}-${path}`
    const existing = ctx.store.collections.cards.get(id)
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: {
        id,
        kind: "file",
        title: `${path} · ${workspace.name}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: {
          repo: workspace.repoId,
          workspaceId: workspace.id,
          path,
          content: text,
          truncated,
          binary,
          /* The address names the computer the bytes came from: this is not the repository's copy. */
          address: `${workspace.repoId} · ${workspace.name} · ${path}`
        }
      }
    })
    return { value: fileValue(`"${workspace.name}" (${workspace.id})`, path, { content: text, truncated, binary }) }
  }

  const listServices: WorkspaceSeam["listServices"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const current = currentOperation(workspace.id)
    const failure = await renderServices(workspace, "services")
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof failure === "string") return failure
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const services = card?.kind === "workspace" ? card.payload.services ?? [] : []
    return {
      value: services.length === 0
        ? `"${workspace.name}" (${workspace.id}) declares no services.`
        : `"${workspace.name}" (${workspace.id}) services: ${
          services.map((service) => `${service.name} (${service.state})`).join(", ")
        }.`
    }
  }

  const listEgress: WorkspaceSeam["listEgress"] = async (workspaceId, cursor) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    const current = currentOperation(workspace.id)
    const failure = await renderEgress(workspace, cursor, "egress")
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof failure === "string") return failure
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const rows = card?.kind === "workspace" ? card.payload.egress ?? [] : []
    return {
      value: rows.length === 0
        ? `"${workspace.name}" (${workspace.id}) made no recorded calls.`
        : `${rows.length} recorded call${rows.length === 1 ? "" : "s"} from "${workspace.name}" (${workspace.id}) — the card lists them.`
    }
  }

  /*
   * The environment images a repository has built (ADR 0002: the environment
   * is stated, never chosen). A refused listing is the server's own message —
   * an empty catalogue would read as "this repository has built nothing",
   * which is a different fact.
   */

  const listEnvironmentImages: WorkspaceSeam["listEnvironmentImages"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const current = currentOperation()
    const answer = await getJson(repoPath(target.repo, "/environment-images"))
    if (!current()) return SIGN_OUT_REFUSAL
    if ("error" in answer) return answer.error
    const images = arrayOf(answer.body, "images").flatMap((entry) => {
      const parsed = parseEnvironmentImage(entry)
      return parsed === null ? [] : [parsed]
    })
    const id = `environment-images-${target.repo}`
    const existing = ctx.store.collections.cards.get(id)
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: {
        id,
        kind: "environment-images",
        title: `Environment images · ${target.repo}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: { repo: target.repo, images }
      }
    })
    return {
      value: images.length === 0
        ? `${target.repo} has built no environment images.`
        : `${images.length} environment image${images.length === 1 ? "" : "s"} on ${target.repo} — the card lists them.`
    }
  }

  /* One terminal-open loop per workspace: a later open supersedes the one before it. */

  const openTerminal: WorkspaceSeam["openTerminal"] = async (workspaceId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = resolveWorkspace(workspaceId)
    if ("error" in resolved) return resolved.error
    const { workspace } = resolved
    if (workspace.status !== "running") {
      return failOnCard(
        workspace,
        `"${workspace.name}" (${workspace.id}) is ${workspace.status}, not running — ${
          workspace.status === "suspended" || workspace.status === "stopped"
            ? "/box.resume it first"
            : "wait for it to settle (the card tracks it)"
        }.`
      )
    }
    const epoch = (terminalOpenEpochs.get(workspace.id) ?? 0) + 1
    terminalOpenEpochs.set(workspace.id, epoch)
    const authorized = currentOperation(workspace.id)
    const current = (): boolean => authorized() && gate() === undefined && terminalOpenEpochs.get(workspace.id) === epoch
    const card = ctx.store.collections.cards.get(cardIdOf(workspace.id))
    const attached = card?.kind === "workspace" ? card.payload.terminalSessionId : undefined
    if (attached !== undefined && attached !== "") {
      const session = await getJson(repoPath(workspace.repoId, `/workspace/sessions/${encodeURIComponent(attached)}`))
      if (!current()) return
      const parsed = "error" in session ? null : parseSession(session.body)
      if (parsed !== null && parsed.status === SESSION_LIVE) {
        renderWorkspace(workspace, { facet: "terminal" })
        return { value: `Re-attached to session ${attached} of "${workspace.name}" (${workspace.id}).` }
      }
    }
    /*
     * The session POST, and — plue#504 — the 503 it may answer while a vm or
     * desktop guest finishes its NixOS activation. The auto-retry is the
     * server's instruction, not this app's optimism: it runs ONLY for a `wait`
     * fault (plue's own word for "nothing is wrong, it is not ready yet",
     * which is what `guest_not_ready` is), waits exactly the pacing the
     * refusal stated, gives up after `terminalSessionRetry.maxAttempts`, and
     * leaves plue's own words on the terminal facet the whole time. A later
     * open on the same workspace supersedes it. Every other refusal —
     * user, infra, dependency, bug — is answered once.
     */
    let created: { readonly body: unknown }
    for (let attempt = 1;; attempt += 1) {
      const answer = await sendJson("POST", repoPath(workspace.repoId, "/workspace/sessions"), {
        workspace_id: workspace.id,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS
      })
      if (!current()) return
      if (!("error" in answer)) {
        created = answer
        break
      }
      /* No HTTP answer at all: there is no status or code to render, only the reach failure. */
      if (answer.status === null) return failOnCard(workspace, answer)
      if (answer.refusal.rawCode === "plan_limit_exceeded") return renderPlanLimit(ctx.store, answer.refusal, ctx.checkout ?? false, ctx.actor())
      /* The worker's own credential-boundary refusal keeps the card-level marker it always had. */
      const proxyGone = answer.code === EGRESS_PROXY_UNAVAILABLE
      renderWorkspace(workspace, {
        facet: "terminal",
        ...(proxyGone ? { egressProxyUnavailable: true } : {}),
        terminalRefusal: storedRefusal(answer.refusal)
      })
      if (!mayAutoRetry(answer.refusal) || attempt >= terminalSessionRetry.maxAttempts) {
        return refusalSentence(answer.refusal)
      }
      if (!await sleep(statedRetryDelayMs(answer.refusal) ?? terminalSessionRetry.defaultDelayMs, workspace.id)) return
      if (!current()) return
    }
    const session = parseSession(created.body)
    if (session === null) return `Smithers Cloud's answer for the new session on ${workspace.id} was malformed.`
    /*
     * A fresh session may still be pending: poll it until it runs, or the
     * honest refusal names what it settled as.
     */
    let live = session
    for (let attempt = 0; live.status !== SESSION_LIVE && attempt < SESSION_SETTLE_ATTEMPTS; attempt += 1) {
      if (live.status === "failed" || live.status === "stopped") break
      if (!await sleep(pollMs, workspace.id) || !current()) return
      const answer = await getJson(repoPath(workspace.repoId, `/workspace/sessions/${encodeURIComponent(session.id)}`))
      if (!current()) return
      const parsed = "error" in answer ? null : parseSession(answer.body)
      if (parsed === null) break
      live = parsed
    }
    if (live.status !== SESSION_LIVE) {
      return failOnCard(workspace, `Session ${live.id} of "${workspace.name}" settled as ${live.status}, not running.`)
    }
    const sessions = await loadSessions(workspace.repoId, workspace.id)
    if (!current()) return
    renderWorkspace(workspace, {
      facet: "terminal",
      terminalSessionId: live.id,
      ...(sessions === null ? {} : { sessions })
    })
    /* A refusal belongs to the act that just ran; this render already dropped it. */
    return { value: `Terminal open on session ${live.id} of "${workspace.name}" (${workspace.id}).` }
  }

  return {
    listWorkspaces,
    refreshWorkspaces,
    openWorkspace,
    viewWorkspace,
    openTerminal,
    suspendWorkspace: (workspaceId) => transitionWorkspace("suspend", workspaceId),
    resumeWorkspace: (workspaceId) => transitionWorkspace("resume", workspaceId),
    listSessions,
    destroySession,
    deleteWorkspace,
    setFacet,
    listFiles,
    readFile,
    listServices,
    listEgress,
    listEnvironmentImages,
    dispose
  }
}
