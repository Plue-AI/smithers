/*
 * Register a repository (docs/mvp/REGISTRATION.md, #2153). The request is
 * durable before the command answers; the import (its own card and toast) and
 * the launch of `register-repository` (the run card, whose toast settles when
 * the analysis reaches review) continue in the background. One unfinished
 * registration per account; a repeated start for the same repository reopens
 * it, and a registered repository replays its recorded run instead of running
 * again. Before a first launch the report another account recorded for the
 * public repository is read (Registration.Report, #3239): when one exists it
 * is the card's cached result and nothing launches; asking again re-analyses.
 */
import type { Card } from "../AppState"
import { canonicalRepo, registrationRun, sharedReportOf, statusOf, unfinished } from "../../cards/Registration"
import type { ControllerContext } from "./context"
import { actorSharedState } from "../ActorBindings"

type Answer = Promise<string | void | { readonly value: string }>
type RegistrationCard = Extract<Card, { kind: "registration" }>

export interface RegistrationController {
  readonly registerRepository: (link: string) => Answer
  /** Reconnect persisted registrations still importing or launching after a reload. */
  readonly resumeRegistrations: () => void
}

export interface RegistrationDependencies {
  /** The allowlist and balance guards every workflow launch applies. */
  readonly guard: () => string | undefined
  /** The existing GitHub import (repos.import): acknowledges at once, progress on its card. */
  readonly importRepository: (repo: string) => Promise<unknown>
  /**
   * Start `register-repository` for the link on the box the import named, else on the
   * repository's default box. The launch path dedupes by its request identity, so asking
   * again adopts the request already made.
   */
  readonly startRegistration: (cloudRepo: string, link: string, box: string | null) => Promise<string | void | { readonly value: string }>
}

export const registrationId = (repo: string) => `registration-${repo}`
/** How long a registration waits for its import: the import seam's own budget. */
const IMPORT_BUDGET_MS = 30 * 60_000

export const createRegistrationController = (ctx: ControllerContext, deps: RegistrationDependencies): RegistrationController => {
  const { store } = ctx
  const { inFlight, admitting } = actorSharedState(ctx, "registration", () => ({
    inFlight: new Map<string, { readonly epoch: number }>(),
    /** The account generation admitting a registration, claimed before any await. */
    admitting: new Set<string>()
  }))
  ctx.onDispose(() => { inFlight.clear(); admitting.clear() })
  const cards = () => [...store.collections.cards.values()]
  const runs = () => [...store.collections.runtimeRuns.values()]
  const read = (id: string): RegistrationCard | undefined => {
    const card = store.collections.cards.get(id)
    return card?.kind === "registration" ? card : undefined
  }
  const login = () => ctx.accountOwner() ?? null
  const admissionSlot = () => JSON.stringify([ctx.accountEpoch, login()])
  const save = (card: RegistrationCard) =>
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
  const patch = async (id: string, payload: Partial<RegistrationCard["payload"]>): Promise<void> => {
    const card = read(id)
    if (card !== undefined) await save({ ...card, status: payload.phase === "failed" ? "error" : "active", payload: { ...card.payload, ...payload } })
  }
  const show = (card: RegistrationCard) => store.dispatch({ type: "card.navigated", actor: ctx.commandActor, card })
  const status = (card: RegistrationCard) => statusOf(card, registrationRun(cards(), card.payload.repo, runs()))
  const busy = (card: RegistrationCard) => card.payload.phase !== "failed" && (inFlight.get(card.id)?.epoch === ctx.accountEpoch || unfinished(status(card)))

  /** The repository's import card; its finished job names the Cloud repository and the box it created. */
  const importOf = (repo: string) => {
    const card = cards().find((entry) => entry.kind === "repo-import" && entry.payload.repo.toLowerCase() === repo)
    return card?.kind === "repo-import" ? card : undefined
  }

  /** The report another account recorded for this public repository at its current commit, else undefined (also when the read fails). */
  const sharedReport = async (cloudRepo: string, repo: string) => {
    const box = importOf(repo)?.payload.workspaceId
    try {
      const answer = await ctx.gateway.call(cloudRepo, "Registration.Report", { repo }, box == null ? undefined : { workspaceId: box })
      if (answer.status !== "ok") return undefined
      const value = answer.value
      return typeof value === "object" && value !== null ? sharedReportOf((value as { report?: unknown }).report, repo) : undefined
    } catch {
      return undefined
    }
  }

  /** Waits on the import card until the job is done or failed. */
  const imported = async (repo: string, current: () => boolean): Promise<{ cloudRepo: string } | string> => {
    const started = Date.now()
    while (current() && Date.now() - started < IMPORT_BUDGET_MS) {
      const card = importOf(repo)
      if (card !== undefined) {
        if (card.payload.phase === "failed") return card.payload.error ?? card.payload.detail ?? "The import failed."
        if (card.payload.phase === "done") {
          const named = card.payload.repository
          return { cloudRepo: named === null || named === undefined ? repo : `${named.owner}/${named.name}` }
        }
      }
      await new Promise<void>((resolve) => ctx.unref(setTimeout(resolve, ctx.workflowPollMs)))
    }
    return "The import did not finish. Try again."
  }

  const send = (id: string) => {
    if (ctx.disposed) return
    const card = read(id)
    if (card === undefined || card.payload.accountOwner !== login()) return
    const repo = card.payload.repo, epoch = ctx.accountEpoch, owner = card.payload.accountOwner
    if (inFlight.get(id)?.epoch === epoch) return
    // A repository ID survives account changes and retries; this flight does not.
    const flight = { epoch }
    inFlight.set(id, flight)
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && inFlight.get(id) === flight &&
      login() === owner && read(id)?.payload.accountOwner === owner
    const release = () => { if (inFlight.get(id) === flight) inFlight.delete(id) }
    const work = (async () => {
      let cloudRepo = read(id)?.payload.cloudRepo ?? null
      if (cloudRepo === null) {
        await deps.importRepository(repo)
        const result = await imported(repo, current)
        if (!current()) return
        if (typeof result === "string") return patch(id, { phase: "failed", error: result })
        cloudRepo = result.cloudRepo
        const cached = await sharedReport(cloudRepo, repo)
        if (!current()) return
        if (cached !== undefined) return patch(id, { phase: "cached", cloudRepo, error: null, cached })
        await patch(id, { phase: "launching", cloudRepo })
      }
      if (!current()) return
      // A first import's box is not in the box list yet; the import card names it.
      const started = await deps.startRegistration(cloudRepo, repo, importOf(repo)?.payload.workspaceId ?? null)
      if (!current()) return
      if (typeof started === "string") return patch(id, { phase: "failed", error: started })
      return patch(id, { phase: "launched", error: null })
    })().catch((error: unknown) => {
      if (!current()) return
      ctx.failures.report("toast.work", error, id)
      return patch(id, { phase: "failed", error: "The registration could not continue. Try again." })
    })
    void work.then(release, (error: unknown) => {
      if (current()) ctx.failures.report("toast.work", error, id)
      release()
    })
  }

  const registerRepository: RegistrationController["registerRepository"] = async (link) => {
    if (ctx.disposed) return
    const epoch = ctx.accountEpoch
    const guarded = deps.guard()
    if (guarded !== undefined) return guarded
    const repo = canonicalRepo(link)
    if (repo === undefined) return "That is not a GitHub repository link."
    const owner = login()
    const id = registrationId(repo)
    const existing = read(id)
    const state = existing === undefined ? undefined : status(existing)
    if (existing !== undefined && busy(existing)) {
      show(existing)
      return { value: `registration-open repo=${repo} status=${state ?? "Analyzing"}` }
    }
    if (existing !== undefined && state === "Ready") {
      const replayed = { ...existing, payload: { ...existing.payload, replay: existing.payload.replay + 1 } }
      await save(replayed)
      if (ctx.disposed || ctx.accountEpoch !== epoch || login() !== owner || read(id)?.payload.accountOwner !== owner) return
      show(replayed)
      return { value: `registration-replayed repo=${repo} status=Ready` }
    }
    const other = cards().flatMap((card) => card.kind === "registration" ? [card] : [])
      .find((card) => card.id !== id && card.payload.accountOwner === owner && busy(card))
    if (other !== undefined) {
      show(other)
      return `Finish registering ${other.payload.repo} first.`
    }
    // A cached result is asked for again: analyse it here, on the repository already imported.
    const reanalyse = state === "Cached" ? existing?.payload.cloudRepo ?? null : null
    // Claimed before the first await, so two quick starts cannot both pass the check above.
    const slot = admissionSlot()
    if (admitting.has(slot)) return "A registration is already starting."
    admitting.add(slot)
    try {
      // A retry can arrive while the failed attempt is still saving its outcome.
      inFlight.delete(id)
      await save({
        id,
        kind: "registration",
        title: "Register a repository",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? store.nextOrdinal(),
        payload: { link: link.trim(), repo, phase: reanalyse === null ? "importing" : "launching", startedAt: Date.now(), error: null, cloudRepo: reanalyse, replay: 0, accountOwner: owner }
      })
      if (ctx.disposed || ctx.accountEpoch !== epoch || login() !== owner || read(id)?.payload.accountOwner !== owner) return
      send(id)
    } finally {
      admitting.delete(slot)
    }
    return { value: `registration-requested repo=${repo}` }
  }

  const resumeRegistrations = () => {
    if (ctx.disposed || admitting.has(admissionSlot())) return
    for (const card of cards()) {
      if (card.kind !== "registration" || card.payload.accountOwner !== login()) continue
      if (card.payload.phase === "importing" || card.payload.phase === "launching") send(card.id)
    }
  }

  return { registerRepository, resumeRegistrations }
}
