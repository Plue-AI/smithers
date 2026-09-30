import { RepositoryJobSchema, storedSetupCandidate, type RepositoryJob, type RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { Card } from "./AppState"

/** A saved draft is not an enabled repository responsibility. */
export const repositoryCiConfigured = (cards: Iterable<Card>, repo: string, owner: string | null): boolean =>
  [...cards].some(card => card.kind === "repository-setup" && card.payload.job === "ci" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.active?.enabled === true)

/**
 * The Smithers Cloud workspace this repository's reviewed jobs run on, as
 * their own setups recorded it. Two setups naming different workspaces name
 * none: nothing here picks between them.
 */
export const repositoryJobWorkspace = (cards: Iterable<Card>, repo: string, owner: string | null): string | undefined => {
  const recorded = new Set([...cards].flatMap(card => card.kind === "repository-setup" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.workspaceId !== undefined ? [card.payload.workspaceId] : []))
  return recorded.size === 1 ? [...recorded][0] : undefined
}

/**
 * A job's registered state, in the setup card's own words. Undefined until the
 * host has answered what is registered: an unread registration is not "Off".
 */
export const repositoryJobState = (setup: Pick<RepositorySetup, "revision" | "active" | "recovery">): string | undefined =>
  setup.recovery !== undefined && setup.recovery.registrationState !== "known" ? undefined
    : setup.active?.enabled ? setup.active.revision === setup.revision ? "Enabled" : "Enabled · draft changes"
    : setup.active ? "Paused"
    : setup.recovery?.trialRegistration ? setup.recovery.trialRegistration.enabled ? "Trial" : "Paused"
    : "Off"

/**
 * {@link repositoryJobState} for every job this account configured on one
 * repository — read from the conversation's cards, which is the only place
 * this app keeps a registration at all.
 *
 * A job's registration enters app state through ONE door: its setup card's
 * recovery, `GET /api/repository-setup/state?repo&job`, asked per job by
 * `controller/repositorySetup.ts` `recover()` for a card that already exists.
 * No collection in `AppStore` holds registrations, and no route hands the app
 * a repository's registrations together, so a job whose card is not open has
 * no state here to read and is listed as its own name.
 *
 * That, not a recovery field, is what the canary census recorded
 * (.artifacts/mvp-canary-walk-20260917/W1-a-buttons-and-chat.json): with
 * `cardsAfterClear []` all five buttons read plain — `Handle issues` included,
 * while the host held it registered and paused at revision 4 — and twenty
 * minutes later, with only the issues card open, `jobButtonsWithState` read
 * "Handle issues · Paused" beside a bare "Build a feature" whose registration
 * was enabled at revision 57. `RepositoryJobs.test.ts` pins both halves.
 */
export const repositoryJobStates = (cards: Iterable<Card>, repo: string, owner: string | null): Partial<Record<RepositoryJob, string>> => {
  const states: Partial<Record<RepositoryJob, string>> = {}
  for (const card of cards) {
    if (card.kind !== "repository-setup" || card.payload.repo !== repo || card.payload.owner !== owner) continue
    const state = repositoryJobState(card.payload)
    if (state !== undefined) states[card.payload.job] = state
  }
  return states
}

/** Jobs with a current, owned registration whose candidate still matches the saved setup. */
export const registeredRepositoryJobs = (cards: Iterable<Card>, repo: string | undefined, owner: string | null): ReadonlySet<RepositoryJob> => {
  const jobs = new Set<RepositoryJob>()
  if (repo === undefined || owner === null) return jobs
  for (const card of cards) {
    if (card.kind !== "repository-setup" || card.payload.repo !== repo || card.payload.owner !== owner) continue
    const { active } = card.payload
    if (!active || active.owned === false || !active.registrationId || !active.sourceRevision || active.revision > card.payload.revision) continue
    if (storedSetupCandidate({ ...card.payload, revision: active.revision, draft: active.draft ?? card.payload.draft }, active.digest)) jobs.add(card.payload.job)
  }
  return jobs
}

/** The job a `<job>.setup` flow configures. */
export const repositoryJobOf = (flow: string): RepositoryJob | undefined => {
  const parsed = RepositoryJobSchema.safeParse(flow.replace(/\.setup$/, ""))
  return parsed.success ? parsed.data : undefined
}
