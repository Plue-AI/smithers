import { formFieldsFor } from "@smthrs/ui/flow-form"
import { GitHubInstallationForm,GitHubInstallationInput } from "../../flows/entries/github"
import { actorSharedState } from "../ActorBindings"
import { refuseCloudSignIn, SIGN_OUT_REFUSAL } from "./CloudSignIn"
/*
 * The GitHub seam (lane sync, ADR 0005; lane L5 against the live routes),
 * behind the `/api/cloud/*` proxy. Every path was read off plue's own router
 * (`cmd/server/router.go`):
 *
 *   GET  /api/repos/{owner}/{repo}/github-app-status  — the GitHub App install
 *        state, with the rate-limit facts when the wire carries them
 *        ({github_rate_limit_limit/remaining/reset}); renders the
 *        connector-setup card, never a transcript line.
 *   POST /api/repos/{owner}/{repo}/github/reconcile   — re-derive the App's
 *        wiring for ONE repository (plue#490). It is gated on repository
 *        write, not on the admin scope, so every writer may run it; the
 *        older global `/api/admin/github-app/reconcile` remains an operator
 *        route and no flow in this app calls it. The status re-read lands
 *        either way, and a refusal is plue's own sentence, verbatim. Its 202
 *        IS a mirror run (plue#502): `run_id` beside the same
 *        `{ id, state, refs[] }` the mirror-sync run answers, so the mirror
 *        card takes it and the same poll follows it. An answer that names no
 *        `run_id` is a server predating #502: the status re-read is then the
 *        whole act, exactly as before.
 *   POST /api/repos/{owner}/{repo}/github/mirror/refs/{ref}/retry — retry ONE
 *        failed ref (plue#491); the ref name is one URL-escaped segment and
 *        the answer is 202 { run_id }, a new run the card then tracks.
 *   GET  /api/repos/{owner}/{repo}                    — the repository DTO,
 *        read for three fields: `mirror_status` (synced | behind | failed |
 *        unconfigured) and plue#491's `behind_refs` / `failed_refs`, which
 *        turn the bare word into `behind GitHub · 3 refs`.
 *   POST /api/repos/{owner}/{repo}/mirror-sync        — start a mirror run
 *        (202 { run_id }).
 *   GET  /api/repos/{owner}/{repo}/mirror-sync/{run_id} — the run:
 *        { state, started_at, finished_at, refs[] { name, from, to, status,
 *        error } }. The refs ARE the card's rows.
 *
 * Rate limits (ADR "Rate limits"): a structured 429
 * `{code: "github_rate_limited", limit, remaining, reset_at}` becomes the
 * card's rate-limit line; a status answer whose remaining is under a fifth
 * of the limit shows the same line. Nothing is invented for a plain 429.
 *
 * No word on a card is this app's: a run's state and a ref's status are the
 * wire's own (`queued | running | succeeded | failed` for a run, `pending |
 * succeeded | failed` for a ref). A FAILED ref is retryable on its own since
 * plue#491; every other ref is not, because plue's route refuses it.
 */
import { CardSchema, type Card, type GitHubAppStatusInput } from "../AppState"
import { canonicalStoredJsonValue } from "../EventValue"
import { resolveTargetRepo } from "../RepoContext"
import { createRunEpochs } from "./RunEpochs"
import type { GitHubRefusal,SeamContext } from "./SeamContext"
import { captureCloudOwner,readGitHubRefusal,trustedHttpsUrl,unreachableSentence } from "./SeamContext"

export { SIGN_OUT_REFUSAL } from "./CloudSignIn"

/**
 * The mirror run poll: one read every `delayMs`, at most `maxAttempts`
 * (fifteen minutes at the production cadence), tolerating `networkRetries`
 * consecutive dropped reads before it stops tracking. Module-level so tests
 * shorten the wait.
 */
export const mirrorSyncPolling = {
  delayMs: 2_000,
  maxAttempts: 450,
  networkRetries: 2
}

/**
 * The honest sign-off when polling can no longer read the run: the header
 * keeps the last state it saw, because the run keeps going upstream.
 */
export const MIRROR_LOST_STREAM_TRIGGER = "lost the run stream — /github.sync re-reads it"

/** plue's `github_mirror_sync_runs.state` CHECK words that mean "no longer moving". */
const RUN_SETTLED = new Set(["succeeded", "failed"])

export interface GitHubSeam {
  /** `github.app [repo]`: read the App status and render the connector-setup card. */
  readonly app: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** Hidden, card-scoped: open the App's install page in the browser. */
  readonly openInstall: (repo?: string) => Promise<string | void>
  /**
   * Consume a GitHub App setup-URL return (`?installation_id=…&setup_action=…`).
   * The query is never trusted: the installation is verified with the
   * user's own session on the server before any repository is adopted.
   * Answers whether the search string carried a return.
   */
  readonly handleInstallReturn: (search: string) => boolean
  readonly chooseInstallation: (installationId: string) => Promise<string | void>
  /** Finish the tutorial's install lesson from one verified installation. */
  /** `github.reconcile [repo]`: re-derive the wiring, then re-read the status. */
  readonly reconcile: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** `github.mirror-sync [repo]`: start a mirror run and track its per-ref results. */
  readonly mirrorSync: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** `github.mirror.retry-ref <ref> [repo]`: retry ONE failed ref (plue#491). */
  readonly retryMirrorRef: (ref: string, repo?: string) => Promise<string | void | { readonly value: string }>
}

export interface GitHubSeamDeps {
  /** The native system-browser door; absent in a plain browser (window.open falls back). */
  readonly openExternal?: (url: string) => Promise<boolean>
}

type SyncPayload = Extract<Card, { kind: "sync-ops" }>["payload"]
type SyncOp = SyncPayload["ops"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

const mirrorRunId = (value: unknown): number | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.run_id)
  return id !== null && id > 0 ? id : null
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Registered App 4163546, shared with apps/server/src/githubApp.ts and plue; verified against GitHub App metadata. */
export const GITHUB_APP_INSTALL_URL = "https://github.com/apps/smitherspreviewrelease/installations/new"
/**
 * Verifies a setup-URL return with the user's session (GitHub's setup-URL
 * docs: never trust `installation_id`). Answers `{ repos: [{ fullName,
 * pushedAt }] }` or `{ repo }`. The route belongs to apps/server and is
 * verified against the session-owned repository inventory and App statuses.
 */
export const INSTALL_VERIFY_PATH = "/api/user/github-app/installations"
/** The lesson that waits on the install, keyed by its signal. */

/** Only the github.com https install origin is worth linking (multi githubInstallUrl.ts). */
export const trustedInstallUrl = (value: string): string | null => trustedHttpsUrl(value, "github.com")

/** What GitHub's setup-URL return carries, once. */
export type InstallReturn =
  | { readonly kind: "installed"; readonly installationId: string }
  | { readonly kind: "requested" }
  | { readonly kind: "unusable" }

/**
 * Classify a setup-URL return. `setup_action=request` with no id is GitHub
 * filing an install REQUEST against an org the person cannot administer: it
 * is waiting on an owner, and asking again files a second one.
 */
export const readInstallReturn = (search: string): InstallReturn | null => {
  const params = new URLSearchParams(search)
  const installationId = params.get("installation_id")
  const setupAction = params.get("setup_action")
  if (installationId === null && setupAction === null) return null
  if (installationId !== null && /^\d+$/.test(installationId)) return { kind: "installed", installationId }
  return setupAction === "request" ? { kind: "requested" } : { kind: "unusable" }
}

interface StatusAnswer {
  readonly installed: boolean
  readonly configured: boolean
  readonly installationId: number | null
  readonly installUrl: string | null
  readonly rateLimit: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null } | null
}

/** The github-app-status answer; the rate-limit facts ride along only when the wire names them. */
const parseStatus = (value: unknown): StatusAnswer | null => {
  if (!isRecord(value)) return null
  if (typeof value.github_app_installed !== "boolean" || typeof value.github_app_configured !== "boolean") return null
  const limit = intOrNull(value.github_rate_limit_limit)
  const remaining = intOrNull(value.github_rate_limit_remaining)
  return {
    installed: value.github_app_installed,
    configured: value.github_app_configured,
    installationId: intOrNull(value.installation_id),
    installUrl: str(value.install_url),
    rateLimit: limit !== null && remaining !== null
      ? { limit, remaining, resetAt: str(value.github_rate_limit_reset) }
      : null
  }
}

/** The line the ADR names when the rate limit is in view (a fifth of the budget left, or a 429). */
export const lowRateLimit = (rateLimit: { readonly limit: number; readonly remaining: number }): boolean =>
  rateLimit.limit > 0 && rateLimit.remaining * 5 < rateLimit.limit

/**
 * One `refs[]` entry of the mirror run, as the sync-ops card's row: plue's
 * `{ name, from, to, status, error }` becomes the ADR's `<from> → <to> ref
 * <name> push`, keeping the status word and the error text verbatim. Since
 * plue#491 a FAILED ref carries its own Retry (`POST …/github/mirror/refs/
 * {ref}/retry`); plue refuses the route for any other status, so no other
 * row offers one.
 */
export const parseMirrorRef = (value: unknown): SyncOp | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  if (name === null) return null
  const error = str(value.error)
  return {
    id: name,
    source: str(value.from) ?? "—",
    target: str(value.to) ?? "—",
    entity: "ref",
    entityId: name,
    action: "push",
    status: str(value.status) ?? "",
    ...(error !== null ? { error } : {}),
    retryable: str(value.status) === "failed",
    at: null
  }
}

interface MirrorRunAnswer {
  readonly state: string
  readonly refs: ReadonlyArray<SyncOp>
}

const parseMirrorRun = (value: unknown): MirrorRunAnswer | null => {
  if (!isRecord(value)) return null
  const state = str(value.state)
  if (state === null || !Array.isArray(value.refs)) return null
  const refs = value.refs.flatMap((entry) => {
    const ref = parseMirrorRef(entry)
    return ref === null ? [] : [ref]
  })
  return { state, refs }
}

export const createGitHubSeam = (ctx: SeamContext, deps: GitHubSeamDeps = {}): GitHubSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}/api${path}`
  /* One tracking loop per repo: a re-run supersedes the loop before it. */
  const epochs = createRunEpochs(ctx, "github-epochs")

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
  }

  const repoPath = (repo: string, suffix: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix === "" ? "" : `/${suffix}`}`
  }

  const readStatus = async (
    repo: string
  ): Promise<{ readonly status: StatusAnswer } | { readonly refusal: GitHubRefusal }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(repo, "github-app-status")))
    } catch (error) {
      return { refusal: { line: unreachableSentence("Smithers Cloud", error) } }
    }
    if (!response.ok) {
      return { refusal: await readGitHubRefusal(response, `The GitHub App status for ${repo} couldn't be read (${response.status})`) }
    }
    const parsed = parseStatus(await response.json().catch(() => null))
    if (parsed === null) return { refusal: { line: `The GitHub App status answer for ${repo} was malformed.` } }
    return { status: parsed }
  }

  /**
   * The repository DTO, read for the three mirror facts it states:
   * `mirror_status` and — plue#491 — `behind_refs` / `failed_refs`. A refused
   * or malformed read answers null: the card then carries NO state word,
   * exactly as the ADR requires ("from the mirror status DTO once it
   * exists, else no state word at all"). A DTO that names the word but no
   * counts leaves the counts absent; `behind GitHub · n refs` needs a number
   * the server actually stated.
   */
  const readMirrorStatus = async (
    repo: string
  ): Promise<{ readonly status: string; readonly behindRefs: number | null; readonly failedRefs: number | null } | null> => {
    try {
      const response = await ctx.http(cloud(repoPath(repo, "")))
      if (!response.ok) return null
      const body: unknown = await response.json().catch(() => null)
      if (!isRecord(body)) return null
      const status = str(body.mirror_status)
      if (status === null) return null
      const behindRefs = intOrNull(body.behind_refs)
      const failedRefs = intOrNull(body.failed_refs)
      return {
        status,
        behindRefs: behindRefs === null || behindRefs < 0 ? null : behindRefs,
        failedRefs: failedRefs === null || failedRefs < 0 ? null : failedRefs
      }
    } catch {
      return null
    }
  }

  /** The mirror facts as the card's own patch; an unread DTO patches nothing. */
  const mirrorPatch = (
    read: { readonly status: string; readonly behindRefs: number | null; readonly failedRefs: number | null } | null
  ): Partial<SyncPayload> =>
    read === null ? {} : {
      mirrorStatus: read.status,
      ...(read.behindRefs === null ? {} : { behindRefs: read.behindRefs }),
      ...(read.failedRefs === null ? {} : { failedRefs: read.failedRefs })
    }

  /** The status row lands in the collection; the card renders from the same answer. */
  const dispatchStatus = (repo: string, status: StatusAnswer): void => {
    const row: GitHubAppStatusInput = {
      repo,
      installed: status.installed,
      configured: status.configured,
      installationId: status.installationId,
      installUrl: status.installUrl,
      rateLimit: status.rateLimit
    }
    ctx.dispatch({ type: "github.app-status.loaded", actor: "system", status: row })
  }

  const renderCard = (
    repo: string,
    answer: { readonly status: StatusAnswer } | { readonly refusal: GitHubRefusal },
    error?: GitHubRefusal
  ): void => {
    const id = `connector-setup-github-${repo}`
    const existing = ctx.store.collections.cards.get(id)
    const rateLimit = error?.rateLimit ?? ("status" in answer
      ? answer.status.rateLimit !== null && lowRateLimit(answer.status.rateLimit)
        ? answer.status.rateLimit
        : null
      : answer.refusal.rateLimit ?? null)
    const message = error?.line ?? ("status" in answer ? undefined : answer.refusal.line)
    const card: Card = {
      id,
      kind: "connector-setup",
      title: `GitHub · ${repo}`,
      status: message !== undefined
        ? "error"
        : "status" in answer && answer.status.installed && answer.status.configured
        ? "acted"
        : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        connector: "github",
        repo,
        phase: "status" in answer && answer.status.installed && answer.status.configured ? "connected" : "setup",
        steps: [],
        ...("status" in answer
          ? {
              installationId: answer.status.installationId,
              configured: answer.status.configured,
              ...(answer.status.installUrl !== null ? { installUrl: answer.status.installUrl } : {})
            }
          : {}),
        ...(message !== undefined ? { error: message } : {}),
        ...(rateLimit !== null ? { rateLimit } : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const app: GitHubSeam["app"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const current = captureCloudOwner(ctx)
    const answer = await readStatus(target.repo)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("status" in answer) dispatchStatus(target.repo, answer.status)
    renderCard(target.repo, answer)
    if ("refusal" in answer) return answer.refusal.line
    return {
      value: answer.status.installed && answer.status.configured
        ? `The Smithers GitHub App is installed on ${target.repo} — the card tracks it.`
        : `The Smithers GitHub App is not installed on ${target.repo} — the card has the install link.`
    }
  }

  const installNotice = async (text: string | undefined, status: "ok" | "failed" = "failed", current = captureCloudOwner(ctx, false)): Promise<void> => {
    if (!current()) return
    if (text) {
      await ctx.dispatch({ type: "toast.shown", actor: "system", key: "github.install", title: text }).isPersisted.promise
      if (!current()) return
      // An ok toast draws no dismiss control, so it leaves only through the
      // controller's door (failures.ts). A failed one keeps its own X and stands.
      if (status === "ok" && ctx.resolveToast) ctx.resolveToast("github.install", { status, detail: "" })
      else await ctx.dispatch({ type: "toast.resolved", actor: "system", key: "github.install", status, detail: "" }).isPersisted.promise
    }
  }
  const adoptInstalled = async (repo: string, repos: ReadonlyArray<{ fullName: string }>, current: () => boolean): Promise<void> => {
    if (!current()) return
    const missing = repos.filter(row => !ctx.store.collections.repositories.has(row.fullName))
    if (missing.length) await ctx.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      ...ctx.store.collections.repositories.values(), ...missing.map(row => {
        const [org = "", name = ""] = row.fullName.split("/")
        return { id: row.fullName, org, name, ownerKind: "user" as const, head: null }
      })
    ] }).isPersisted.promise
    if (!current()) return
    await ctx.dispatch({ type: "repo.selected", actor: "system", id: repo }).isPersisted.promise
  }
  const verifyInstall = async (installationId?: string, stillCurrent = captureCloudOwner(ctx, false)): Promise<{ readonly error: string; readonly empty?: boolean } | void> => {
    if (!stillCurrent()) return
    const notice = async (error: string): Promise<{ readonly error: string }> => {
      await installNotice(error, "failed", stillCurrent)
      return { error }
    }
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${INSTALL_VERIFY_PATH}${installationId === undefined ? "" : `/${encodeURIComponent(installationId)}`}`)
    } catch {
      // The tapped fetch already recorded the thrown request; its text is not copy.
      if (!stillCurrent()) return
      return notice("Nothing came back from GitHub that I could confirm. Try again?")
    }
    if (!stillCurrent()) { await response.body?.cancel(); return }
    if (!response.ok) {
      const fallback = response.status === 404 || response.status === 501
        ? "GitHub sent you back, but this Smithers server can't confirm installs yet, so I won't guess which repository you chose. Try again later, or choose Later."
        : `GitHub sent you back, but Smithers couldn't confirm the install (${response.status}). Try again?`
      const refusal = await readGitHubRefusal(response, fallback)
      if (stillCurrent()) return notice(refusal.line)
      return
    }
    const body: unknown = await response.json().catch(() => null)
    if (!stillCurrent()) return
    if (!isRecord(body) || (!Array.isArray(body.repos) && typeof body.repo !== "string")) return notice("Smithers Cloud returned an unreadable installation list. Try again.")
    const rows = isRecord(body) && Array.isArray(body.repos) ? body.repos : isRecord(body) && typeof body.repo === "string" ? [{ fullName: body.repo }] : []
    const repos = rows.flatMap((row) => {
      if (!isRecord(row)) return []
      const fullName = str(row.fullName) ?? str(row.full_name)
      return fullName === null || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(fullName) ? [] : [{ fullName, installationId: intOrNull(row.installationId) ?? intOrNull(row.installation_id), pushedAt: str(row.pushedAt) ?? str(row.pushed_at) ?? "" }]
    })
    if (repos.length !== rows.length) return notice("Smithers Cloud returned an unreadable installation list. Try again.")
    const installations = new Map<number, string>()
    for (const repo of repos) if (repo.installationId !== null) installations.set(repo.installationId, repo.fullName.split("/")[0]!)
    for (const repo of repos) {
      if (repo.installationId !== null) dispatchStatus(repo.fullName, {
        installed: true, configured: true, installationId: repo.installationId, installUrl: null, rateLimit: null
      })
    }
    if (installationId === undefined && installations.size > 1) {
      const id = "form-github.app.choose"
      const existing = ctx.store.collections.cards.get(id)
      await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
        id, kind: "flow-form", title: "Choose a GitHub App installation", status: "active",
        createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: { flow: "github.app.choose", via: ctx.actor() === "smithers" ? "agent" : "user", given: {}, draft: {},
          fields: formFieldsFor(GitHubInstallationInput, GitHubInstallationForm).map(field => ({ ...field,
            options: [...installations].map(([id, owner]) => ({ value: String(id), label: owner })) })) }
      } }).isPersisted.promise
      return
    }
    // Several repositories in ONE installation: newest active, the rest in the chip menu.
    const chosen = [...repos].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))[0]
    if (chosen === undefined) {
      return { ...await notice("No installed repository is visible yet. Select a repository on GitHub, then return here to check again."), empty: true }
    }
    if (stillCurrent()) await adoptInstalled(chosen.fullName, repos, stillCurrent)
  }
  const chooseInstallation: GitHubSeam["chooseInstallation"] = async installationId => {
    if (!/^\d+$/.test(installationId)) return "Choose a GitHub App installation from the list."
    const current = captureCloudOwner(ctx, false)
    const result = await verifyInstall(installationId, current)
    if (!current()) return SIGN_OUT_REFUSAL
    // A failed verification must keep the shared form retryable, not mark it submitted.
    return typeof result === "object" ? result.error : undefined
  }
  const handleInstallReturn: GitHubSeam["handleInstallReturn"] = (search) => {
    const answer = readInstallReturn(search)
    if (answer === null) return false
    if (answer.kind === "installed") void verifyInstall(answer.installationId)
    else if (answer.kind === "requested") void installNotice("Waiting for an org owner to approve the install.", "ok")
    else void installNotice("Nothing came back from GitHub. Try again?")
    return true
  }
  /* The install pill's check, one at a time: a second press joins it instead of paging the inventory again. */
  const installCheck = actorSharedState(ctx, "install-check", () => ({ current: undefined as { readonly owner: () => boolean; readonly run: Promise<string | void> } | undefined }))
  /** GitHub's chooser for an account without a repository yet. */
  const openChooser = (): Promise<string | void> => {
    if (ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") return Promise.resolve("Log in to GitHub first; the install page asks as you.")
    if (installCheck.current?.owner()) return installCheck.current.run
    const current = captureCloudOwner(ctx, false)
    if (!current()) return Promise.resolve(SIGN_OUT_REFUSAL)
    /*
     * A browser opens a popup only within the click's user activation (about
     * five seconds in Chromium), and verifying a real inventory takes longer.
     * Reserve the page now, as signIn does, and navigate it once the check
     * says to install. The native door needs no activation.
     */
    const popup = deps.openExternal === undefined && typeof window !== "undefined" ? window.open("about:blank", "_blank") : null
    if (popup) popup.opener = null
    const check = { owner: current, run: checkThenOpen(popup, current).finally(() => {
      if (installCheck.current === check) installCheck.current = undefined
    }) }
    installCheck.current = check
    return check.run
  }
  const checkThenOpen = async (popup: Window | null, current: () => boolean): Promise<string | void> => {
    let opened = false
    try {
      const result = await verifyInstall(undefined, current)
      if (!current()) return SIGN_OUT_REFUSAL
      if (!result?.empty) return result?.error
      // Flush before either browser door; the native host may navigate away too.
      await ctx.store.settled?.()
      if (!current()) return SIGN_OUT_REFUSAL
      // The return callback belongs to this check, even if the page switches accounts.
      if (typeof window !== "undefined") window.addEventListener("focus", () => {
        if (current()) void verifyInstall(undefined, current)
      }, { once: true })
      if (deps.openExternal !== undefined) {
        const didOpen = await deps.openExternal(GITHUB_APP_INSTALL_URL)
        if (!current()) return SIGN_OUT_REFUSAL
        if (!didOpen) return "The GitHub install page could not open. Try again."
        return
      }
      if (typeof window === "undefined") return
      if (popup === null) return "Your browser blocked the GitHub install page. Allow pop-ups for this site, then try again."
      if (popup.closed) return "The GitHub install page was closed before it loaded. Try again."
      popup.location.href = GITHUB_APP_INSTALL_URL
      opened = true
    } finally {
      // An adopted installation, refusal, or retired owner leaves no blank tab.
      if (!opened) popup?.close()
    }
  }

  const openInstall: GitHubSeam["openInstall"] = async (explicit) => {
    if (explicit === undefined && ctx.store.session().activeRepoKey == null && ctx.store.collections.repositories.size === 0 && ctx.store.collections.identitySessions.get("identity")?.state === "signed-in") return openChooser()
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const row = ctx.store.collections.githubAppStatuses.get(target.repo)
    const card = ctx.store.collections.cards.get(`connector-setup-github-${target.repo}`)
    const installUrl = (card?.kind === "connector-setup" ? card.payload.installUrl : undefined) ?? row?.installUrl ?? null
    const trusted = installUrl !== null ? trustedInstallUrl(installUrl) : null
    if (trusted === null) return `No install link for ${target.repo} yet — /github.app reads the status first.`
    if (deps.openExternal !== undefined) void deps.openExternal(trusted)
    else if (typeof window !== "undefined") window.open(trusted, "_blank", "noopener")
    return undefined
  }

  const reconcile: GitHubSeam["reconcile"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const current = captureCloudOwner(ctx)
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(target.repo, "github/reconcile")), { method: "POST" })
    } catch (error) {
      if (!current()) return SIGN_OUT_REFUSAL
      return unreachableSentence("Smithers Cloud", error)
    }
    if (!current()) return SIGN_OUT_REFUSAL
    if (!response.ok) {
      /* plue gates this on repository write (plue#490): a refusal is its own sentence, verbatim. */
      const refusal2 = await readGitHubRefusal(response, `The reconcile failed (${response.status})`)
      if (!current()) return SIGN_OUT_REFUSAL
      const answer = await readStatus(target.repo)
      if (!current()) return SIGN_OUT_REFUSAL
      if ("status" in answer) dispatchStatus(target.repo, answer.status)
      renderCard(target.repo, answer, refusal2)
      return refusal2.line
    }
    const body = await response.json().catch(() => null)
    if (!current()) return SIGN_OUT_REFUSAL
    const runId = mirrorRunId(body)
    const answer = await readStatus(target.repo)
    if (!current()) return SIGN_OUT_REFUSAL
    if ("status" in answer) dispatchStatus(target.repo, answer.status)
    renderCard(target.repo, answer)
    /*
     * The run plue started is tracked whatever the status re-read did: a
     * refused GET on a different route is not a reason to drop the run the
     * platform already named.
     */
    const id = runId === null ? null : String(runId)
    if (id !== null) {
      const mirror = mirrorPatch(await readMirrorStatus(target.repo))
      if (!current()) return SIGN_OUT_REFUSAL
      beginRun(target.repo, id, body, mirror, `reconcile started · run ${id}`, current)
    }
    if ("refusal" in answer) return answer.refusal.line
    /* A server that names no run id reconciled all the same; nothing more is claimed for it. */
    if (id === null) return { value: `Reconciled — the GitHub card for ${target.repo} re-read the App status.` }
    return {
      value: `Reconciled — the GitHub card for ${target.repo} re-read the App status; mirror run ${id} tracks the refs.`
    }
  }

  /* ---- the mirror run ---- */

  const mirrorCardIdOf = (repo: string): string => `sync-ops-mirror-${repo}`

  const upsertMirrorCard = (repo: string, patch: Partial<SyncPayload>, observation = false): ReturnType<SeamContext["dispatch"]> | undefined => {
    const id = mirrorCardIdOf(repo)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "sync-ops" ? existing.payload : undefined
    const payload: SyncPayload = {
      subject: `${repo} → GitHub`,
      source: "github-mirror",
      repo,
      runState: patch.runState !== undefined ? patch.runState : prior?.runState ?? null,
      ops: (patch.ops ?? prior?.ops ?? []).map((op) => ({ ...op })),
      ...(patch.runId !== undefined ? { runId: patch.runId } : prior?.runId !== undefined ? { runId: prior.runId } : {}),
      ...(patch.mirrorStatus !== undefined
        ? { mirrorStatus: patch.mirrorStatus }
        : prior?.mirrorStatus !== undefined
        ? { mirrorStatus: prior.mirrorStatus }
        : {}),
      ...(patch.behindRefs !== undefined
        ? { behindRefs: patch.behindRefs }
        : prior?.behindRefs !== undefined
        ? { behindRefs: prior.behindRefs }
        : {}),
      ...(patch.failedRefs !== undefined
        ? { failedRefs: patch.failedRefs }
        : prior?.failedRefs !== undefined
        ? { failedRefs: prior.failedRefs }
        : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : prior?.trigger !== undefined ? { trigger: prior.trigger } : {}),
      ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : prior?.rateLimit !== undefined ? { rateLimit: prior.rateLimit } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {})
    }
    const card: Card = {
      id,
      kind: "sync-ops",
      title: `Mirror sync · ${repo} → GitHub`,
      status: payload.error !== undefined ? "error" : payload.runState === "succeeded" ? "acted" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    if (observation) {
      // Only unchanged, committed observations are idle. An optimistic edit
      // must not hide a missing receipt or an intervening card change.
      const value = (row: Card | undefined) => row === undefined ? undefined : canonicalStoredJsonValue(CardSchema.parse(row))
      const next = value(card)
      if (value(existing) === next && value(ctx.store.committedCard(id)) === next) return
    }
    return ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /*
   * The run poll: `{ state, refs[] }` in, the header word and the card's
   * rows out, until the run settles (`succeeded`/`failed`), a newer run
   * supersedes it, or the budget runs out.
   */
  const trackMirrorRun = async (repo: string, runId: string, epoch: number, owner: () => boolean): Promise<void> => {
    const current = (): boolean => owner() && epochs.isLive(repo, epoch)
    const settle = (): void => epochs.settle(repo, epoch)
    let drops = 0
    for (let attempt = 0; attempt < mirrorSyncPolling.maxAttempts; attempt += 1) {
      await wait(mirrorSyncPolling.delayMs)
      if (!current()) return
      let response: Response
      try {
        response = await ctx.http(cloud(`${repoPath(repo, "mirror-sync")}/${encodeURIComponent(runId)}`))
      } catch {
        /*
         * A dropped poll is retried; plue's run keeps pushing refs for up to
         * fifteen minutes, so one lost connection is not a failed run and
         * never reads as one (review finding 3). Only a refusal below is
         * terminal.
         */
        if (!current()) return
        drops += 1
        if (drops <= mirrorSyncPolling.networkRetries) continue
        upsertMirrorCard(repo, { trigger: MIRROR_LOST_STREAM_TRIGGER })
        settle()
        return
      }
      drops = 0
      if (!current()) return
      if (!response.ok) {
        const refusal = await readGitHubRefusal(response, `Reading the mirror run failed (${response.status})`)
        if (!current()) return
        upsertMirrorCard(repo, {
          error: refusal.line,
          ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
        })
        settle()
        return
      }
      const run = parseMirrorRun(await response.json().catch(() => null))
      if (!current()) return
      if (run === null) {
        upsertMirrorCard(repo, { error: `The mirror run answer for ${repo} was malformed.` })
        settle()
        return
      }
      await upsertMirrorCard(repo, { runState: run.state, ops: [...run.refs] }, true)?.isPersisted.promise
      if (!current()) return
      if (RUN_SETTLED.has(run.state)) {
        /* The run moved the mirror: re-read the repository's own words and counts for it. */
        const mirror = await readMirrorStatus(repo)
        if (mirror !== null && current()) await upsertMirrorCard(repo, mirrorPatch(mirror), true)?.isPersisted.promise
        settle()
        return
      }
    }
    settle()
  }

  /*
   * A named run lands on the mirror card and the poll takes it from there.
   * The answer may already BE the run (plue#502's reconcile carries the whole
   * `{ id, state, refs[] }`) or name only its id (the mirror-sync trigger's
   * `{ run_id }`); the card states whatever the answer stated, and the poll
   * fills the rest.
   */
  const beginRun = (repo: string, runId: string, body: unknown, mirror: Partial<SyncPayload>, trigger: string, current: () => boolean): void => {
    const run = parseMirrorRun(body)
    upsertMirrorCard(repo, {
      runId,
      runState: run?.state ?? null,
      ops: run === null ? [] : [...run.refs],
      trigger,
      error: undefined,
      ...mirror
    })
    const epoch = epochs.start(repo)
    // The store surfaces failed writes; this observer must stop reading.
    void trackMirrorRun(repo, runId, epoch, current).catch(() => epochs.settle(repo, epoch))
  }

  const mirrorSync: GitHubSeam["mirrorSync"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    return startMirrorRun(target.repo, repoPath(target.repo, "mirror-sync"), {
      failed: "The mirror sync failed",
      started: (id) => `sync started · run ${id}`,
      value: (id, repo) => `Mirror run ${id} started for ${repo} — the card tracks its refs.`,
      unnamed: (repo) => `Smithers Cloud started the mirror sync for ${repo} without naming a run id.`
    })
  }

  /*
   * One mirror run, started at `path` and tracked on the repository's card.
   * The whole-mirror sync and plue#491's per-ref retry answer the SAME
   * 202 `{ run_id }` and are tracked by the same poll, so they share this.
   */
  const startMirrorRun = async (
    repo: string,
    path: string,
    words: {
      readonly failed: string
      readonly started: (runId: string) => string
      readonly value: (runId: string, repo: string) => string
      readonly unnamed: (repo: string) => string
    }
  ): Promise<string | { readonly value: string }> => {
    const current = captureCloudOwner(ctx)
    /* The repository's own mirror facts, before the run says anything. */
    const mirror = mirrorPatch(await readMirrorStatus(repo))
    if (!current()) return SIGN_OUT_REFUSAL
    let response: Response
    try {
      response = await ctx.http(cloud(path), { method: "POST" })
    } catch (error) {
      if (!current()) return SIGN_OUT_REFUSAL
      const message = unreachableSentence("Smithers Cloud", error)
      upsertMirrorCard(repo, { error: message, ...mirror })
      return message
    }
    if (!current()) return SIGN_OUT_REFUSAL
    if (!response.ok) {
      const refusal = await readGitHubRefusal(response, `${words.failed} (${response.status})`)
      if (!current()) return SIGN_OUT_REFUSAL
      upsertMirrorCard(repo, {
        error: refusal.line,
        ...mirror,
        ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
      })
      return refusal.line
    }
    const body = await response.json().catch(() => null)
    if (!current()) return SIGN_OUT_REFUSAL
    const runId = mirrorRunId(body)
    if (runId === null) {
      const message = words.unnamed(repo)
      upsertMirrorCard(repo, { error: message, ...mirror })
      return message
    }
    const id = String(runId)
    beginRun(repo, id, body, mirror, words.started(id), current)
    return { value: words.value(id, repo) }
  }

  /*
   * plue#491 `POST …/github/mirror/refs/{ref}/retry` (202 { run_id }). Ref
   * names carry slashes and arrive as ONE escaped segment, so the name is
   * encoded whole — `refs/heads/main` is one parameter, never three.
   */
  const retryMirrorRef: GitHubSeam["retryMirrorRef"] = async (ref, explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const name = ref.trim()
    if (name === "") return "github.mirror.retry-ref needs a ref: /github.mirror.retry-ref <ref> [owner/repo]"
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    return startMirrorRun(target.repo, repoPath(target.repo, `github/mirror/refs/${encodeURIComponent(name)}/retry`), {
      failed: `The retry of ${name} failed`,
      started: (id) => `${name} retried · run ${id}`,
      value: (id, repo) => `${name} is being pushed again on ${repo} — run ${id}; the card tracks it.`,
      unnamed: (repo) => `Smithers Cloud retried ${name} on ${repo} without naming a run id.`
    })
  }

  return { app, openInstall, chooseInstallation, handleInstallReturn, reconcile, mirrorSync, retryMirrorRef }
}
