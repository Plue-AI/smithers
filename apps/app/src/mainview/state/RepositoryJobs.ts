import { RepositoryJobSchema, storedSetupCandidate, type RepositoryJob, type RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { Card, RepositoryJobObservation } from "./AppState"

/** Unknown observations never imply that CI is unconfigured. */
export const repositoryCiConfigured = (
  observations: Iterable<RepositoryJobObservation>, repo: string, owner: string | null, selectedWorkspaceId: string | null = null
): boolean | undefined => {
  const ci = knownRegistrations(observations, repo, owner, selectedWorkspaceId).find(row => row.job === "ci")
  return ci === undefined ? undefined : ci.registration.active?.enabled === true
}

/** An owned, verified job binding; conflicting registered boxes remain unresolved. */
export const repositoryJobWorkspace = (
  observations: Iterable<RepositoryJobObservation>, repo: string, owner: string | null, selectedWorkspaceId: string | null = null
): { readonly workspaceId: string } | { readonly error: string } | undefined => {
  const recorded = new Set(knownRegistrations(observations, repo, owner, selectedWorkspaceId, false).flatMap(({ registration }) => {
    const policy = registration.active ?? registration.trial
    return policy?.owned === true ? [policy.workspaceId] : []
  }))
  if (recorded.size > 1) return { error: "The repository's registered jobs use different boxes." }
  const workspaceId = [...recorded][0]
  if (workspaceId === undefined) return undefined
  if (selectedWorkspaceId !== null && workspaceId !== selectedWorkspaceId) return { error: "The repository's registered jobs belong to another box." }
  return { workspaceId }
}

/** Persisted setup routing provenance is not evidence of an enabled registration. */
export const recordedSetupWorkspace = (cards: Iterable<Card>, repo: string, owner: string | null):
  { readonly workspaceId: string } | { readonly error: string } | undefined => {
  if (owner === null) return undefined
  const boxes = new Set([...cards].flatMap(card => card.kind === "repository-setup" && card.payload.repo === repo
    && card.payload.owner?.toLowerCase() === owner.toLowerCase() && card.payload.workspaceId !== undefined ? [card.payload.workspaceId] : []))
  if (boxes.size > 1) return { error: "The repository's saved setups name different boxes." }
  const workspaceId = [...boxes][0]
  return workspaceId === undefined ? undefined : { workspaceId }
}

const registrationState = (active: { readonly enabled: boolean } | undefined, trial: { readonly enabled: boolean } | undefined, changed: boolean): string =>
  active ? active.enabled ? changed ? "Enabled · draft changes" : "Enabled" : "Paused"
    : trial ? trial.enabled ? "Trial" : "Paused" : "Off"

/**
 * A job's registered state, in the setup card's own words. Undefined until the
 * host has answered what is registered: an unread registration is not "Off".
 */
export const repositoryJobState = (setup: Pick<RepositorySetup, "revision" | "active" | "recovery">): string | undefined =>
  setup.recovery !== undefined && setup.recovery.registrationState !== "known" ? undefined
    : registrationState(setup.active, setup.recovery?.trialRegistration, setup.active?.revision !== setup.revision)

/** One unambiguous collection key for the account, repository, selection and job. */
export const repositoryJobObservationId = (owner: string, repo: string, selectedWorkspaceId: string | null, job: RepositoryJob): string =>
  JSON.stringify([owner.toLowerCase(), repo, selectedWorkspaceId, job])

/**
 * The host's verified registrations in scope. A row's registration is its
 * last verified answer and stays readable while a re-read is in flight or
 * failed; a row the host never answered has none and reads as unknown.
 */
const knownRegistrations = (observations: Iterable<RepositoryJobObservation>, repo: string, owner: string | null, selectedWorkspaceId: string | null, requireMatchingBox = true) =>
  [...observations].flatMap(row => {
    if (owner === null || row.owner.toLowerCase() !== owner.toLowerCase() || row.repo !== repo
      || row.selectedWorkspaceId !== selectedWorkspaceId || row.registration?.state !== "known") return []
    const policy = row.registration.active ?? row.registration.trial
    if (requireMatchingBox && selectedWorkspaceId !== null && policy !== undefined && policy.workspaceId !== selectedWorkspaceId) return []
    return [{ job: row.job, registration: row.registration }]
  })

/** Verified registrations are independent of cards; an open draft only annotates its own registration. */
export const repositoryJobStates = (
  observations: Iterable<RepositoryJobObservation>, cards: Iterable<Card>, repo: string, owner: string | null,
  selectedWorkspaceId: string | null = null
): Partial<Record<RepositoryJob, string>> => {
  const states: Partial<Record<RepositoryJob, string>> = {}
  const drafts = [...cards]
  for (const { job, registration } of knownRegistrations(observations, repo, owner, selectedWorkspaceId)) {
    const active = registration.active
    const changed = active !== undefined && drafts.some(card => card.kind === "repository-setup" && card.payload.repo === repo
      && card.payload.owner?.toLowerCase() === owner?.toLowerCase() && card.payload.job === job
      && card.payload.active?.registrationId === active.registrationId && card.payload.revision > active.revision
      && (card.payload.workspaceId === undefined || card.payload.workspaceId === active.workspaceId))
    states[job] = registrationState(active, registration.trial, changed)
  }
  return states
}

/**
 * Jobs with an owned, verified host registration (paused included) whose
 * candidate still matches its stored draft. Only host observations count:
 * a saved card draft never completes setup.
 */
export const registeredRepositoryJobs = (
  observations: Iterable<RepositoryJobObservation>, repo: string | undefined, owner: string | null,
  selectedWorkspaceId: string | null = null
): ReadonlySet<RepositoryJob> => new Set(repo === undefined ? [] : knownRegistrations(observations, repo, owner, selectedWorkspaceId)
  .flatMap(({ job, registration }) => {
    const active = registration.active
    return active?.owned === true && storedSetupCandidate({ repo, job, revision: active.revision, draft: active.draft }, active.digest)
      ? [job]
      : []
  }))

/** Whether the host has answered a registration read in scope: before it does, no registered job is not yet "none". */
export const repositoryJobsKnown = (
  observations: Iterable<RepositoryJobObservation>, repo: string, owner: string | null, selectedWorkspaceId: string | null = null
): boolean => knownRegistrations(observations, repo, owner, selectedWorkspaceId, false).length > 0

/** The job a `<job>.setup` flow configures. */
export const repositoryJobOf = (flow: string): RepositoryJob | undefined => {
  const parsed = RepositoryJobSchema.safeParse(flow.replace(/\.setup$/, ""))
  return parsed.success ? parsed.data : undefined
}
