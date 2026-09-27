/*
 * Register a repository (docs/mvp/REGISTRATION.md, #2153). The request is
 * durable before the command answers; the import (its own card and toast) and
 * the launch of `register-repository` (the run card, whose toast settles when
 * the analysis reaches review) continue in the background. One unfinished
 * registration per account; a repeated start for the same repository reopens
 * it, and a registered repository replays its recorded run instead of running
 * again.
 */
import type { Card } from "../AppState"
import { canonicalRepo, registrationRun, statusOf, unfinished } from "../../cards/Registration"
import type { ControllerContext } from "./context"

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
   * Start `register-repository` for the link on the imported repository's workspace. The launch
   * path dedupes by its request identity, so asking again adopts the request already made.
   */
  readonly startRegistration: (cloudRepo: string, link: string) => Promise<string | void | { readonly value: string }>
}

export const registrationId = (repo: string) => `registration-${repo}`
/** How long a registration waits for its import: the import seam's own budget. */
const IMPORT_BUDGET_MS = 30 * 60_000

export const createRegistrationController = (ctx: ControllerContext, deps: RegistrationDependencies): RegistrationController => {
  const { store } = ctx
  const inFlight = new Map<string, Promise<unknown>>()
  /** The account whose registration is being admitted right now; claimed before any await. */
  const admitting = new Set<string>()
  const cards = () => [...store.collections.cards.values()]
  const runs = () => [...store.collections.runtimeRuns.values()]
  const read = (id: string): RegistrationCard | undefined => {
    const card = store.collections.cards.get(id)
    return card?.kind === "registration" ? card : undefined
  }
  const login = () => {
    const identity = store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" ? identity.login : null
  }
  const save = (card: RegistrationCard) =>
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
  const patch = async (id: string, payload: Partial<RegistrationCard["payload"]>): Promise<void> => {
    const card = read(id)
    if (card !== undefined) await save({ ...card, status: payload.phase === "failed" ? "error" : "active", payload: { ...card.payload, ...payload } })
  }
  const show = (card: RegistrationCard) => store.dispatch({ type: "card.navigated", actor: ctx.commandActor, card })
  const status = (card: RegistrationCard) => statusOf(card, registrationRun(cards(), card.payload.repo, runs()))
  const busy = (card: RegistrationCard) => card.payload.phase !== "failed" && (inFlight.has(card.id) || unfinished(status(card)))

  /** Waits on the import card until the job is done or failed. */
  const imported = async (repo: string, current: () => boolean): Promise<{ cloudRepo: string } | string> => {
    const started = Date.now()
    while (current() && Date.now() - started < IMPORT_BUDGET_MS) {
      const card = cards().find((entry) => entry.kind === "repo-import" && entry.payload.repo.toLowerCase() === repo)
      if (card?.kind === "repo-import") {
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
    const card = read(id)
    if (card === undefined || inFlight.has(id)) return
    const repo = card.payload.repo, epoch = ctx.accountEpoch, owner = card.payload.accountOwner
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch && login() === owner && read(id) !== undefined
    const work = (async () => {
      let cloudRepo = read(id)?.payload.cloudRepo ?? null
      if (cloudRepo === null) {
        await deps.importRepository(repo)
        const result = await imported(repo, current)
        if (!current()) return
        if (typeof result === "string") return patch(id, { phase: "failed", error: result })
        cloudRepo = result.cloudRepo
        await patch(id, { phase: "launching", cloudRepo })
      }
      if (!current()) return
      const started = await deps.startRegistration(cloudRepo, repo)
      if (!current()) return
      if (typeof started === "string") return patch(id, { phase: "failed", error: started })
      return patch(id, { phase: "launched", error: null })
    })().catch((error: unknown) => {
      ctx.failures.report("toast.work", error, id)
      return patch(id, { phase: "failed", error: "The registration could not continue. Try again." })
    })
    inFlight.set(id, work)
    void work.finally(() => inFlight.delete(id))
  }

  const registerRepository: RegistrationController["registerRepository"] = async (link) => {
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
      show(replayed)
      return { value: `registration-replayed repo=${repo} status=Ready` }
    }
    const other = cards().flatMap((card) => card.kind === "registration" ? [card] : [])
      .find((card) => card.id !== id && card.payload.accountOwner === owner && busy(card))
    if (other !== undefined) {
      show(other)
      return `Finish registering ${other.payload.repo} first.`
    }
    // Claimed before the first await, so two quick starts cannot both pass the check above.
    const slot = owner ?? ""
    if (admitting.has(slot)) return "A registration is already starting."
    admitting.add(slot)
    try {
      await save({
        id,
        kind: "registration",
        title: "Register a repository",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? store.nextOrdinal(),
        payload: { link: link.trim(), repo, phase: "importing", startedAt: Date.now(), error: null, cloudRepo: null, replay: 0, accountOwner: owner }
      })
      send(id)
    } finally {
      admitting.delete(slot)
    }
    return { value: `registration-requested repo=${repo}` }
  }

  const resumeRegistrations = () => {
    for (const card of cards()) {
      if (card.kind !== "registration" || card.payload.accountOwner !== login()) continue
      if (card.payload.phase === "importing" || card.payload.phase === "launching") send(card.id)
    }
  }

  return { registerRepository, resumeRegistrations }
}
