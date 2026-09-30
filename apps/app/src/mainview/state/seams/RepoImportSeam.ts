/*
 * The repo-import seam: POST /api/github/import {owner, repo} starts the job;
 * GET /api/github/import/{jobId} polls it; POST /api/github/import/{jobId}/retry
 * re-runs a failed job (the route exists). Progress lives on one upserted
 * "repo-import" card (phase starting → running → done | failed). Lane sync
 * moved the routes behind the `/api/cloud/*` proxy like every other lane
 * seam and taught the card the job's own progress fields (stage, counts,
 * repository, workspace_id) plus the structured-429 rate-limit line — every
 * one parsed loose, rendered only when the wire carries it. Reference: multi
 * src/smithersCloud/githubImport.ts (startImport/pollImport) against plue
 * internal/routes/github_import.go.
 */
import { canonicalStoredJsonValue } from "../EventValue"
import { accountOwnerOf } from "../AccountOwner"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { GitHubRefusal, SeamContext } from "./SeamContext"
import { createRunEpochs } from "./RunEpochs"
import { captureCloudOwner, readGitHubRefusal, refusalWords } from "./SeamContext"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { presentAppFailure } from "../controller/AppFailure"
import { actorSharedState } from "../ActorBindings"
import { Data } from "effect"

export interface RepoImportSeam {
  readonly importRepository: (repo?: string, options?: { readonly registration?: boolean }) => Promise<string | void | { readonly value: string }>
  /** `repos.import.retry <jobId>`: re-run the failed job the card tracks. */
  readonly retryImport: (jobId: string) => Promise<string | void | { readonly value: string }>
  /** Reconnect persisted starting/running imports after a controller reload. */
  readonly resume: () => void
}

/**
 * Poll cadence knobs, module-level so tests can shorten the wait: one status
 * check every `delayMs`, at most `maxAttempts` checks, and `networkRetries`
 * consecutive dropped polls tolerated before the loop stops tracking. The
 * budget is thirty minutes at the production cadence: a large repository's
 * clone outlives two, and a card that gave up early sent the user into a
 * re-run and a 409 (review finding 7).
 */
export const repoImportPolling = {
  delayMs: 2_000,
  maxAttempts: 900,
  networkRetries: 2
}

/** The honest sign-off when polling can no longer see the job. */
export const REPO_IMPORT_LOST_STREAM_DETAIL = "lost the import stream — run /repos.import again to re-check"

type ImportPhase = "starting" | "running" | "done" | "failed"

interface ImportCount {
  readonly done: number
  readonly total: number
}

/** Plue's import job answer, reduced to what the card tracks. The wire shape
 *  is plue's ImportJob: {importJobId, status, stage?, counts?, error?,
 *  repository?, workspace_id?}. */
interface ImportJobAnswer {
  readonly jobId: string
  readonly status: "cloning" | "ready" | "failed"
  readonly stage: string | null
  readonly counts: { readonly refs: ImportCount; readonly objects: ImportCount; readonly issues: ImportCount } | null
  readonly error: string | null
  readonly repository: { readonly owner: string; readonly name: string } | null
  readonly workspaceId: string | null
}

/** A retry whose request was replaced while it read the job; its flight settles as superseded. */
class RepoImportSuperseded extends Data.TaggedError("RepoImportSuperseded")<Record<never, never>> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const parseCount = (value: unknown): ImportCount | null => {
  if (!isRecord(value)) return null
  const { done, total } = value
  if (typeof done !== "number" || !Number.isInteger(done) || done < 0) return null
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return null
  return { done, total }
}

const parseImportJob = (body: unknown): ImportJobAnswer | null => {
  if (!isRecord(body)) return null
  const jobId = body.importJobId
  const status = body.status
  if (typeof jobId !== "string" || jobId === "") return null
  if (status !== "cloning" && status !== "ready" && status !== "failed") return null
  const counts = (() => {
    if (!isRecord(body.counts)) return null
    const refs = parseCount(body.counts.refs)
    const objects = parseCount(body.counts.objects)
    const issues = parseCount(body.counts.issues)
    return refs !== null && objects !== null && issues !== null ? { refs, objects, issues } : null
  })()
  const repository = (() => {
    if (!isRecord(body.repository)) return null
    const owner = body.repository.owner
    const name = body.repository.name
    return typeof owner === "string" && owner !== "" && typeof name === "string" && name !== ""
      ? { owner, name }
      : null
  })()
  return {
    jobId,
    status,
    stage: typeof body.stage === "string" && body.stage !== "" ? body.stage : null,
    counts,
    error: typeof body.error === "string" && body.error !== "" ? body.error : null,
    repository,
    workspaceId: typeof body.workspace_id === "string" && body.workspace_id !== "" ? body.workspace_id : null
  }
}

/** Human detail per in-flight stage — the reference's importStageDetail map. */
const STAGE_DETAIL: Readonly<Record<string, string>> = {
  resolving: "Contacting GitHub…",
  creating_repo: "Creating mirror…",
  cloning_github: "Downloading from GitHub…",
  pushing_mirror: "Uploading to Smithers Cloud…",
  importing_refs: "Importing branches…",
  creating_bookmark: "Preparing default branch…",
  provisioning_workspace: "Provisioning workspace…"
}

const stageDetail = (job: ImportJobAnswer): string | null =>
  job.status === "cloning" && job.stage !== null ? (STAGE_DETAIL[job.stage] ?? null) : null

const cardStatus = (phase: ImportPhase): "active" | "acted" | "error" =>
  phase === "done" ? "acted" : phase === "failed" ? "error" : "active"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The card fields one job answer carries; absent wire fields touch nothing. */
const jobProgress = (job: ImportJobAnswer): CardPatch => ({
  jobId: job.jobId,
  phase: "running",
  detail: null,
  ...(job.stage !== null ? { stage: job.stage } : {}),
  ...(job.counts !== null ? { counts: job.counts } : {}),
  ...(job.error !== null ? { error: job.error } : {}),
  ...(job.repository !== null ? { repository: job.repository } : {}),
  ...(job.workspaceId !== null ? { workspaceId: job.workspaceId } : {})
})

/** The card fields a poll or a refusal can touch; unset keys keep their last values. */
interface CardPatch {
  readonly jobId?: string | null
  readonly phase: ImportPhase
  readonly detail: string | null
  readonly stage?: string | null
  readonly counts?: NonNullable<ImportJobAnswer["counts"]>
  readonly error?: string | null
  readonly repository?: ImportJobAnswer["repository"]
  readonly workspaceId?: string | null
  readonly rateLimit?: GitHubRefusal["rateLimit"]
  readonly requestId?: string
  readonly requestKind?: "start" | "retry"
  readonly retryMode?: "reconnect" | "restart"
  readonly accountOwner?: string | null
}

export const createRepoImportSeam = (ctx: SeamContext): RepoImportSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}/api${path}`
  /*
   * One tracking loop per repo: a re-run (the card's "Try again", or the
   * command again) bumps the epoch so a superseded loop stops upserting a
   * card the new run now owns.
   */
  const epochs = createRunEpochs(ctx, "repoimport-epochs")
  type Flight = { readonly work: Promise<unknown>; readonly admitted: Promise<unknown>; readonly current: () => boolean }
  const pending = actorSharedState(ctx, "repoimport-pending", () => new Map<string, Flight>())
  const accountOwner = (): string | null => accountOwnerOf(ctx.store.collections.identitySessions.get("identity")) ?? null
  const pendingKey = (repo: string): string => `${accountOwner() ?? "anonymous"}:${repo}`.toLowerCase()
  const activeFlight = (repo: string): Flight | undefined => {
    const key = pendingKey(repo)
    const flight = pending.get(key)
    if (flight?.current()) return flight
    pending.delete(key)
    return undefined
  }
  const hold = (repo: string, flight: Flight): Flight => {
    const key = pendingKey(repo)
    pending.set(key, flight)
    const release = () => { if (pending.get(key) === flight) pending.delete(key) }
    void flight.work.then(release, release)
    return flight
  }
  const requestCurrent = (repo: string, requestId: string): boolean => {
    const card = ctx.store.collections.cards.get(`repo-import-${repo}`)
    return ctx.isDisposed?.() !== true && card?.kind === "repo-import" &&
      card.payload.requestId === requestId && card.payload.accountOwner === accountOwner()
  }

  /** Imports a registration asked for: the registration card shows them, so they post no card of their own. */
  const forRegistration = new Set<string>()
  const upsert = (repo: string, ordinal: number, createdAt: number, patch: CardPatch): Promise<unknown> => {
    const id = `repo-import-${repo}`
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "repo-import" ? existing.payload : undefined
    const card: Card = {
      id,
      kind: "repo-import",
      title: `Import · ${repo}`,
      status: cardStatus(patch.phase),
      createdAt,
      // The creation-time ordinal, passed unchanged on every upsert so the
      // card never jumps around the transcript while the job progresses.
      ordinal,
      payload: {
        repo,
        jobId: patch.jobId !== undefined ? patch.jobId : prior?.jobId ?? null,
        phase: patch.phase,
        detail: patch.detail,
        ...(patch.stage !== undefined
          ? { stage: patch.stage }
          : prior?.stage !== undefined
          ? { stage: prior.stage }
          : {}),
        ...(patch.counts !== undefined
          ? { counts: patch.counts }
          : prior?.counts !== undefined
          ? { counts: prior.counts }
          : {}),
        ...(patch.error !== undefined
          ? { error: patch.error }
          : prior?.error !== undefined
          ? { error: prior.error }
          : {}),
        ...(patch.repository !== undefined
          ? { repository: patch.repository }
          : prior?.repository !== undefined
          ? { repository: prior.repository }
          : {}),
        ...(patch.workspaceId !== undefined
          ? { workspaceId: patch.workspaceId }
          : prior?.workspaceId !== undefined
          ? { workspaceId: prior.workspaceId }
          : {}),
        ...(patch.rateLimit !== undefined
          ? { rateLimit: patch.rateLimit }
          : prior?.rateLimit !== undefined
          ? { rateLimit: prior.rateLimit }
          : {}),
        ...(patch.requestId !== undefined ? { requestId: patch.requestId } : prior?.requestId !== undefined ? { requestId: prior.requestId } : {}),
        ...(patch.requestKind !== undefined ? { requestKind: patch.requestKind } : prior?.requestKind !== undefined ? { requestKind: prior.requestKind } : {}),
        ...(patch.retryMode !== undefined ? { retryMode: patch.retryMode } : prior?.retryMode !== undefined ? { retryMode: prior.retryMode } : {}),
        ...(patch.accountOwner !== undefined ? { accountOwner: patch.accountOwner } : prior?.accountOwner !== undefined ? { accountOwner: prior.accountOwner } : {}),
        ...(forRegistration.has(repo.toLowerCase()) || prior?.registration === true ? { registration: true } : {})
      }
    }
    // Polling can return the same progress for minutes. Only a committed
    // observation permits skipping its next write; optimistic rows do not.
    const committed = ctx.store.committedCard(id)
    if (committed !== undefined && canonicalStoredJsonValue(committed) === canonicalStoredJsonValue(card)) return Promise.resolve()
    return ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card }).isPersisted.promise
  }

  const track = async (
    repo: string,
    jobId: string,
    ordinal: number,
    createdAt: number,
    epoch: number,
    requestId: string,
    owner: () => boolean
  ): Promise<string | void | typeof TOAST_SUPERSEDED> => {
    /*
     * The fence supersedes stale loops; a loop that has reached a terminal
     * hand-off retires its own live marker, guarded so a re-run's newer
     * epoch is never retired out from under it (a retired marker reads as
     * !== any stale epoch, which is the same stop signal the supersede check
     * already relies on). The epoch itself is never handed out twice, so a
     * loop parked in a poll across a re-run can never pass this fence.
     */
    const settleEpoch = (): void => epochs.settle(repo, epoch)
    let failures = 0
    for (let attempt = 0; attempt < repoImportPolling.maxAttempts; attempt += 1) {
      await sleep(repoImportPolling.delayMs)
      const card = ctx.store.collections.cards.get(`repo-import-${repo}`)
      if (!owner() || ctx.isDisposed?.() === true || !epochs.isLive(repo, epoch) || card?.kind !== "repo-import" ||
        card.payload.requestId !== requestId || card.payload.accountOwner !== accountOwner()) return TOAST_SUPERSEDED
      let job: ImportJobAnswer | null = null
      let refusal: GitHubRefusal | null = null
      try {
        const response = await ctx.http(cloud(`/github/import/${encodeURIComponent(jobId)}`))
        if (response.ok) job = parseImportJob(await response.json().catch(() => undefined))
        else refusal = await readGitHubRefusal(response, `Reading the import job failed (HTTP ${response.status})`)
      } catch {
        // A dropped poll is retried below; the job keeps running upstream.
      }
      const currentCard = ctx.store.collections.cards.get(`repo-import-${repo}`)
      if (!owner() || ctx.isDisposed?.() === true || !epochs.isLive(repo, epoch) || currentCard?.kind !== "repo-import" ||
        currentCard.payload.requestId !== requestId || currentCard.payload.accountOwner !== accountOwner()) return TOAST_SUPERSEDED
      if (refusal !== null) {
        /*
         * The server refused the read (a 401, a 500, a structured 429): its
         * line (refusalLine) lands on the card — with the rate-limit line when it
         * carried one — and Try again reconnects to the same job. Only a dropped
         * connection or an unreadable answer counts against the drop budget
         * (review finding 6: every non-OK poll used to read as a lost stream).
         */
        await upsert(repo, ordinal, createdAt, {
          jobId,
          phase: "failed",
          detail: refusal.line,
          retryMode: "reconnect",
          error: refusal.line,
          ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
        })
        settleEpoch()
        return refusal.line
      }
      if (job === null) {
        failures += 1
        if (failures <= repoImportPolling.networkRetries) continue
        await upsert(repo, ordinal, createdAt, { jobId, phase: "running", detail: REPO_IMPORT_LOST_STREAM_DETAIL })
        settleEpoch()
        return REPO_IMPORT_LOST_STREAM_DETAIL
      }
      failures = 0
      const progress = { ...jobProgress(job), jobId }
      if (job.status === "ready") {
        await upsert(repo, ordinal, createdAt, { ...progress, phase: "done", detail: null })
        settleEpoch()
        return
      }
      if (job.status === "failed") {
        await upsert(repo, ordinal, createdAt, {
          ...progress,
          phase: "failed",
          retryMode: "restart",
          detail: job.error ?? "The import failed upstream."
        })
        settleEpoch()
        return job.error ?? "The import failed upstream."
      }
      await upsert(repo, ordinal, createdAt, { ...progress, phase: "running", detail: stageDetail(job) ?? job.error })
    }
    // Attempts exhausted without a terminal status: same honest hand-off as a
    // lost stream — the command re-checks the job when run again.
    if (!owner() || !epochs.isLive(repo, epoch)) return TOAST_SUPERSEDED
    await upsert(repo, ordinal, createdAt, { jobId, phase: "running", detail: REPO_IMPORT_LOST_STREAM_DETAIL })
    settleEpoch()
    return REPO_IMPORT_LOST_STREAM_DETAIL
  }

  /*
   * The shared start path: POST the start (or retry) route, then render and
   * track the job the answer names. `begin` upserts the starting card and
   * owns the epoch.
   */
  const startJob = async (
    repo: string,
    request: () => Promise<Response>,
    requestId: string,
    owner: () => boolean,
    options: { readonly keepOrdinal?: { readonly ordinal: number; readonly createdAt: number } } = {}
  ): Promise<string | void | typeof TOAST_SUPERSEDED> => {
    if (!owner() || !requestCurrent(repo, requestId)) return TOAST_SUPERSEDED
    const ordinal = options.keepOrdinal?.ordinal ?? ctx.nextOrdinal()
    const createdAt = options.keepOrdinal?.createdAt ?? Date.now()
    const epoch = epochs.start(repo)
    const current = (): boolean => {
      const card = ctx.store.collections.cards.get(`repo-import-${repo}`)
      return owner() && ctx.isDisposed?.() !== true && epochs.isLive(repo, epoch) && card?.kind === "repo-import" &&
        card.payload.requestId === requestId && card.payload.accountOwner === accountOwner()
    }
    /* The job this card already tracks — a 409 "already active" resumes it when the answer names none. */
    const tracked = ctx.store.collections.cards.get(`repo-import-${repo}`)
    const priorJobId = tracked?.kind === "repo-import" ? tracked.payload.jobId : null
    await upsert(repo, ordinal, createdAt, { phase: "starting", detail: null, retryMode: "restart", jobId: options.keepOrdinal === undefined ? null : undefined })
    if (!current()) { epochs.settle(repo, epoch); return TOAST_SUPERSEDED }
    /*
     * A start that ends without a tracking loop (every branch that returns
     * before `track` below) has a terminal epoch: settle it the same way
     * the loop's own terminal branches do, or one dead entry accumulates
     * per imported repo for the session.
     */
    const settleEpoch = (): void => epochs.settle(repo, epoch)

    let response: Response
    try {
      response = await request()
    } catch (error) {
      if (!current()) return TOAST_SUPERSEDED
      // A tagged failure keeps its own sentence; a thrown request's text stays in the fetch tap.
      const message = presentAppFailure(error, () => {}, { fault: "infra", sentence: "The import couldn't start. Nothing answered; try again.", actions: ["retry"] }).sentence
      await upsert(repo, ordinal, createdAt, { phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    if (!current()) return TOAST_SUPERSEDED
    if (response.status === 409) {
      /*
       * An active conflict is trackable only when either the answer or this
       * exact persisted attempt names a job. Every other 409 remains retryable.
       */
      const body: unknown = await response.json().catch(() => null)
      if (!current()) return TOAST_SUPERSEDED
      const record = isRecord(body) ? body : {}
      const said = str(record.message) ?? ""
      const active = record.code === "github_import_already_active" || /already being imported/i.test(said)
      // plue's words only when the reader can act on them; otherwise the act and whose fault it was.
      const fallback = "The import couldn't start (HTTP 409)"
      const message = active
        ? "Already being imported."
        : refusalLine(refusalOf({ body, status: 409, message: refusalWords(body, fallback, 409) }), fallback)
      if (!active) {
        await upsert(repo, ordinal, createdAt, { phase: "failed", detail: message, error: message })
        settleEpoch()
        return message
      }
      const activeJobId = str(record.importJobId) ?? str(record.import_job_id) ?? str(record.job_id) ?? priorJobId
      if (activeJobId === null) {
        await upsert(repo, ordinal, createdAt, { phase: "failed", detail: message, error: message })
        settleEpoch()
        return message
      }
      await upsert(repo, ordinal, createdAt, { jobId: activeJobId, phase: "running", detail: message })
      return track(repo, activeJobId, ordinal, createdAt, epoch, requestId, owner)
    }
    if (!response.ok) {
      const refusal = await readGitHubRefusal(response, `The import couldn't start (HTTP ${response.status})`)
      if (!current()) return TOAST_SUPERSEDED
      await upsert(repo, ordinal, createdAt, {
        phase: "failed",
        detail: refusal.line,
        retryMode: priorJobId === null ? "restart" : "reconnect",
        error: refusal.line,
        ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
      })
      settleEpoch()
      return refusal.line
    }
    const job = parseImportJob(await response.json().catch(() => undefined))
    if (!current()) return TOAST_SUPERSEDED
    if (job === null) {
      const message = "The import answer was malformed — the job id never arrived."
      await upsert(repo, ordinal, createdAt, { phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    const progress = jobProgress(job)
    if (job.status === "ready") {
      await upsert(repo, ordinal, createdAt, { ...progress, phase: "done", detail: "already imported" })
      settleEpoch()
      return undefined
    }
    if (job.status === "failed") {
      const message = job.error ?? "The import failed upstream."
      await upsert(repo, ordinal, createdAt, { ...progress, phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    await upsert(repo, ordinal, createdAt, { ...progress, phase: "running", detail: stageDetail(job) })
    // The toast lifetime includes this returned tracking promise.
    return track(repo, job.jobId, ordinal, createdAt, epoch, requestId, owner)
  }


  const background = (
    repo: string,
    requestId: string,
    persisted: Promise<unknown>,
    run: (current: () => boolean) => Promise<unknown>,
    slot: { readonly ordinal: number; readonly createdAt: number }
  ): Flight => {
    const owner = captureCloudOwner(ctx, false)
    const current = () => owner() && requestCurrent(repo, requestId)
    const work = async () => {
      try { await persisted } catch {
        if (!current()) return TOAST_SUPERSEDED
        const message = "The import request couldn't be saved."
        await upsert(repo, slot.ordinal, slot.createdAt, { phase: "failed", detail: message, error: message })
        return message
      }
      if (!current()) return TOAST_SUPERSEDED
      return run(current)
    }
    return hold(repo, {
      work: ctx.withToast
        ? ctx.withToast("repos.import." + repo, "Importing " + repo + "…", repo + " imported", work, false, current)
        : work(),
      admitted: persisted,
      current
    })
  }

  const reconnect = (card: Extract<Card, { kind: "repo-import" }>): Flight => {
    const repo = card.payload.repo
    const requestId = crypto.randomUUID()
    const jobId = card.payload.jobId as string
    const persisted = upsert(repo, card.ordinal, card.createdAt, {
      phase: "running", detail: null, error: null, retryMode: "reconnect",
      requestId, accountOwner: accountOwner()
    })
    return background(repo, requestId, persisted, current =>
      track(repo, jobId, card.ordinal, card.createdAt, epochs.start(repo), requestId, current), card)
  }

  const launch = (
    repo: string,
    prior?: Extract<Card, { kind: "repo-import" }>,
    requestKind: "start" | "retry" = "start",
    recover = false
  ): Flight => {
    const ordinal = prior?.ordinal ?? ctx.nextOrdinal()
    const createdAt = prior?.createdAt ?? Date.now()
    const requestId = recover && prior?.payload.requestId ? prior.payload.requestId : crypto.randomUUID()
    const jobId = prior?.payload.jobId ?? null
    const persisted = ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
      id: "repo-import-" + repo, kind: "repo-import", title: "Import · " + repo,
      status: "active", createdAt, ordinal,
      payload: { repo, jobId, phase: "starting", detail: null, requestId, requestKind,
        retryMode: "restart", accountOwner: accountOwner() }
    } }).isPersisted.promise
    return background(repo, requestId, persisted, current => startJob(repo, async () => {
      if (requestKind === "retry" && jobId !== null) {
        if (recover) {
          const observed = await ctx.http(cloud("/github/import/" + encodeURIComponent(jobId)))
          if (!current()) throw new RepoImportSuperseded()
          if (!observed.ok) return observed
          const job = parseImportJob(await observed.clone().json().catch(() => undefined))
          if (job?.status !== "failed") return observed
          if (!current()) throw new RepoImportSuperseded()
        }
        return ctx.http(cloud("/github/import/" + encodeURIComponent(jobId) + "/retry"), { method: "POST" })
      }
      const [owner, name] = repo.split("/") as [string, string]
      return ctx.http(cloud("/github/import"), { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, repo: name }) })
    }, requestId, current, { keepOrdinal: { ordinal, createdAt } }), { ordinal, createdAt })
  }

  const acknowledge = async (repo: string, flight: Flight): Promise<string | { readonly value: string }> => {
    try { await flight.admitted } catch { return "The import request couldn't be saved." }
    if (!flight.current()) return "The import request was interrupted."
    return { value: "Import requested for " + repo + "." }
  }

  const importRepository: RepoImportSeam["importRepository"] = async (explicit, options) => {
    if (options?.registration === true && explicit !== undefined) forRegistration.add(explicit.toLowerCase())
    if (ctx.isDisposed?.() || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") {
      return "Sign in to import a repository."
    }
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved.error
    const existing = [...ctx.store.collections.cards.values()].find(card =>
      card.kind === "repo-import" && card.payload.repo.toLowerCase() === resolved.repo.toLowerCase())
    const repo = existing?.kind === "repo-import" ? existing.payload.repo : resolved.repo
    const active = activeFlight(repo)
    if (active) return acknowledge(repo, active)
    const prior = existing?.kind === "repo-import" &&
      (existing.payload.accountOwner === accountOwner() || existing.payload.accountOwner === undefined)
      ? existing : undefined
    if (prior?.payload.jobId && (prior.payload.phase === "running" ||
      (prior.payload.phase === "failed" && prior.payload.retryMode === "reconnect"))) {
      return acknowledge(repo, reconnect(prior))
    }
    const recovering = prior?.payload.phase === "starting"
    return acknowledge(repo, launch(repo, prior, recovering ? prior.payload.requestKind ?? "start" : "start", recovering))
  }

  const retryImport: RepoImportSeam["retryImport"] = async (jobId) => {
    if (ctx.isDisposed?.() || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") {
      return "Sign in to import a repository."
    }
    const trimmed = jobId.trim()
    if (trimmed === "") return "repos.import.retry needs a job id: /repos.import.retry <jobId>"
    const entry = [...ctx.store.collections.cards.values()].find(card =>
      card.kind === "repo-import" && card.payload.jobId === trimmed)
    if (entry?.kind !== "repo-import") {
      return "No import card tracks job " + trimmed + " — the retry button lives on the failed import's card."
    }
    const repo = entry.payload.repo
    if (entry.payload.accountOwner !== undefined && entry.payload.accountOwner !== accountOwner()) {
      return "This import belongs to another account. Start a new import for the current account."
    }
    const active = activeFlight(repo)
    if (active) return acknowledge(repo, active)
    if (entry.payload.phase === "running" || entry.payload.retryMode === "reconnect") {
      return acknowledge(repo, reconnect(entry))
    }
    return acknowledge(repo, launch(repo, entry, "retry", entry.payload.phase === "starting"))
  }

  const resume = (): void => {
    queueMicrotask(() => {
      if (ctx.isDisposed?.() || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") return
      for (const card of ctx.store.collections.cards.values()) {
        if (card.kind !== "repo-import" || (card.payload.phase !== "starting" && card.payload.phase !== "running")) continue
        if (card.payload.accountOwner === undefined || card.payload.accountOwner !== accountOwner()) continue
        void importRepository(card.payload.repo)
      }
    })
  }

  return { importRepository, retryImport, resume }
}
