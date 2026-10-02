import type { RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { dynamicFlowAction, flowAction } from "../flows/FlowAction"
import { repositoryFlowName } from "../flows/entries/flow"
import { unmetRequirements, visible, type CatalogItem, type CommandState } from "../flows/registry"
import { activeCatalogRepositoryId, activeRepositoryId, selectedBoxBinding } from "../state/RepoContext"
import { registeredRepositoryJobs, repositoryJobOf, repositoryJobsKnown, repositoryJobStates } from "../state/RepositoryJobs"
import { cloudWebHost } from "../Onboarding"
import type { RepositoryFlow, RepositoryJobObservation } from "../state/AppState"
import type { RunDynamicCommand } from "./CardFamily"
import "./SetupChecklist.css"
import { GuideKey } from "../onboarding/GuideButton"

/*
 * The start-page checklist: what part of setup is done, and the one flow that
 * advances each remaining step. Completion is derived from live state — a step
 * checks itself off when the world says it happened, never when its button was
 * clicked. The last step is the repository's job tiles; once every step is
 * complete only the tiles remain, and the dismissal hides the whole card.
 */
export interface SetupProgress {
  readonly signedIn: boolean
  readonly localAuth?: boolean
  /** The hosted web app: the signup is the GitHub sign-in, so its step is never listed. */
  readonly cloud?: boolean
  readonly hasRepo: boolean
  readonly hasSetup: boolean
  /** The person has written to Smithers in this conversation. */
  readonly talked?: boolean
}

interface SetupStep {
  readonly id: string
  readonly label: string
  /** The first of these flows registered on this host performs the step. */
  readonly flows: ReadonlyArray<string>
  readonly done: (state: SetupProgress) => boolean
}

export const SETUP_STEPS: ReadonlyArray<SetupStep> = [
  /* Will, 2026-10-01: the checklist asks the person to open Chat (⌘K) and talk to Smithers. */
  { id: "talk", label: "Talk to Smithers", flows: ["chat.open"], done: state => state.talked === true },
  { id: "connect-github", label: "Connect GitHub", flows: ["auth.sign-in"], done: state => state.signedIn },
  { id: "add-repository", label: "Add a repository", flows: ["repos.import"], done: state => state.hasRepo },
  { id: "set-up-job", label: "Set up a job", flows: ["issues.setup"], done: state => state.hasSetup },
]

export interface ResolvedStep {
  readonly id: string
  readonly label: string
  readonly complete: boolean
  /** Undefined when no host flow can perform the step: the row is a fact, not a button. */
  readonly flow?: string
  readonly args?: string
}

export function resolveSteps(commands: readonly CatalogItem[], state: SetupProgress, repo?: string): ReadonlyArray<ResolvedStep> {
  const catalog = visible(commands)
  return SETUP_STEPS.filter(step => !(state.cloud && step.id === "connect-github")).map(step => {
    const flow = step.flows.find(name => catalog.some(item => item.name === name))
    return { id: step.id, label: step.id === "connect-github" && state.localAuth ? "Sign in" : step.label, complete: step.done(state), flow, args: flow === "issues.setup" ? repo : undefined }
  })
}

/** Recommendation policy projects real commands; the full catalog stays in Chat. */
export const FIRST_RUN_JOBS = ["issues.setup", "review.setup", "ci.setup", "feature.setup", "chores.setup"] as const

export function firstRunGroups(commands: readonly CatalogItem[], state: CommandState, featuredFlows: ReadonlyArray<RepositoryFlow> = []) {
  const catalog = visible(commands)
  const available = (name: string) => {
    const flow = catalog.find(item => item.name === name)
    return flow && unmetRequirements(flow, state).length === 0 ? flow : undefined
  }
  const jobs = FIRST_RUN_JOBS.flatMap(name => {
    const flow = available(name)
    return flow === undefined ? [] : [flow]
  })
  // A repository's featured rows already have executable slash leaves. The
  // workflow identity keeps a row colliding with an app command out of sight.
  const featured = featuredFlows.filter(row => row.featured).flatMap(row => {
    const flow = available(repositoryFlowName(row.id))
    return flow?.workflow === row.id ? [flow] : []
  })
  return [
    ...(jobs.length ? [{ namespace: "repository", label: "Repository jobs", flows: jobs }] : []),
    ...(featured.length ? [{ namespace: "featured", label: "Featured flows", flows: featured }] : [])
  ]
}

/** A configured job reads its state; a job with none is still its own name. */
const jobState = (states: Partial<Record<RepositoryJob, string>> | undefined, flow: string) => {
  const job = repositoryJobOf(flow)
  const state = job === undefined ? undefined : states?.[job]
  return state === undefined ? null : ` · ${state}`
}

/*
 * What each job does, drawn rather than said (MINIMAL TEXT): an issue turning
 * into a merged change, a pull request collecting review marks, a pipeline
 * going green, a feature branch growing off main, a clock firing a chore.
 */
const JOB_PICTURES: Readonly<Record<string, string>> = {
  "issues.setup": '<rect class="frp-soft" x="8" y="14" width="34" height="32" rx="4"/><circle class="frp-bad" cx="17" cy="23" r="3"/><path class="frp-ink" d="M24 23h12M15 31h20M15 38h14"/><path class="frp-acc" d="M46 30h14M56 25l5 5-5 5"/><rect class="frp-soft" x="64" y="14" width="30" height="32" rx="4"/><path class="frp-ok" d="M71 30l5 5 10-11"/>',
  "review.setup": '<circle class="frp-acc" cx="22" cy="14" r="5"/><circle class="frp-acc" cx="22" cy="46" r="5"/><circle class="frp-ok" cx="58" cy="46" r="5"/><path class="frp-acc" d="M22 19v22M58 41V26a8 8 0 0 0-8-8H36M40 13l-4 5 4 5"/><rect class="frp-soft" x="68" y="8" width="26" height="9" rx="3"/><path class="frp-ok" d="M72 12.5l2.5 2.5 5-5"/><rect class="frp-soft" x="68" y="22" width="26" height="9" rx="3"/><path class="frp-ok" d="M72 26.5l2.5 2.5 5-5"/><rect class="frp-soft" x="68" y="36" width="26" height="9" rx="3"/><path class="frp-ok" d="M72 40.5l2.5 2.5 5-5"/>',
  "ci.setup": '<path class="frp-ink" d="M14 30h10M38 30h10M62 30h10"/><circle class="frp-okf" cx="8" cy="30" r="5"/><circle class="frp-okf" cx="32" cy="30" r="5"/><circle class="frp-okf" cx="56" cy="30" r="5"/><circle class="frp-acc" cx="80" cy="30" r="5"/><path class="frp-acc" d="M86 30h8"/><path class="frp-ink" d="M8 42v6h72v-6" opacity=".5"/>',
  "feature.setup": '<path class="frp-ink" d="M10 44h80"/><circle class="frp-ink frp-fill" cx="24" cy="44" r="4"/><circle class="frp-ink frp-fill" cx="80" cy="44" r="4"/><path class="frp-acc" d="M24 44c8-10 12-22 30-22h12"/><circle class="frp-accf" cx="66" cy="22" r="4"/><path class="frp-acc" d="M66 22h12"/><path class="frp-acc" d="M78 22c4 0 6 10 2 22" opacity=".5" stroke-dasharray="3 3"/>',
  "chores.setup": '<circle class="frp-ink frp-fill" cx="34" cy="30" r="18"/><path class="frp-ink" d="M34 16v3M48 30h-3M34 44v-3M20 30h3" opacity=".5"/><path class="frp-acc" d="M34 30V19M34 30l7 4"/><path class="frp-acc" d="M56 30h8M64 30l4-4M64 30l4 4" opacity=".6"/><rect class="frp-soft" x="72" y="20" width="20" height="20" rx="4"/><path class="frp-ok" d="M77 30l3 3 6-7"/>'
}

const JobPicture = ({ flow }: { flow: string }) => {
  const picture = JOB_PICTURES[flow]
  return picture === undefined ? null : <svg className="setup-checklist-picture" viewBox="0 0 100 60" aria-hidden="true" dangerouslySetInnerHTML={{ __html: picture }} />
}

/** A host-confirmed registration for this account and repository, including paused jobs. */
export function hasRegisteredSetup(
  observations: Iterable<RepositoryJobObservation>, repo: string | undefined, owner: string | null,
  selectedWorkspaceId: string | null = null
): boolean {
  return registeredRepositoryJobs(observations, repo, owner, selectedWorkspaceId).size > 0
}

export type FirstRunGroup = ReturnType<typeof firstRunGroups>[number]

export function SetupChecklistCard({ steps, groups = [], repo, jobStates, completedJobs, dismissed = false, onRunCommand: dispatchFlow, onDismiss = () => {} }: {
  steps: ReadonlyArray<ResolvedStep>
  /** The last step's tiles: the five repository jobs, then the repository's featured flows. */
  groups?: ReadonlyArray<FirstRunGroup>
  repo?: string
  jobStates?: Partial<Record<RepositoryJob, string>>
  completedJobs?: ReadonlySet<RepositoryJob>
  /** Dismissed, the card collapses to its tiles: every job stays one press away (apps/app/AGENTS.md First-run). */
  dismissed?: boolean
  onRunCommand: RunDynamicCommand
  onDismiss?: () => void
}) {
  const onRunCommand: RunDynamicCommand = (flow, args) => {
    if (flow === "app.first-run.dismiss") return onDismiss()
    dispatchFlow(flow, args)
  }
  const done = steps.filter(step => step.complete).length
  // Only a verified registration checks off a job; an inspected but inactive
  // setup can display "Off" without claiming the person has completed it.
  const tiles = groups.length === 0 ? null : <div className="setup-checklist-tiles">
    {groups.map(group => <section key={group.namespace} aria-label={group.label}>
      {group.flows.map(flow => <button type="button" key={flow.name}
        data-done={group.namespace === "repository" && completedJobs?.has(repositoryJobOf(flow.name)!) === true || undefined}
        {...dynamicFlowAction(onRunCommand, flow.name, repo)}>
        <JobPicture flow={flow.name} />{flow.summary}{group.namespace === "repository" ? jobState(jobStates, flow.name) : null}</button>)}
    </section>)}
  </div>
  if (dismissed || done === steps.length) return tiles === null ? null : <section className="setup-checklist" data-testid="setup-checklist" data-complete aria-label="Set up Smithers">{tiles}</section>
  return <section className="setup-checklist" data-testid="setup-checklist" aria-label="Set up Smithers">
    <header><h2>Set up Smithers</h2><span className="setup-checklist-count">{done} of {steps.length}</span>
      <button type="button" aria-label="Dismiss" {...flowAction(onRunCommand, "app.first-run.dismiss")}>×</button></header>
    <progress value={done} max={steps.length}>{done} of {steps.length}</progress>
    <ol>
      {steps.map(step => <li key={step.id} data-complete={step.complete || undefined}>
        {step.complete ? <><span aria-hidden="true">✓</span>{step.label}</> :
          step.id === "set-up-job" && tiles !== null ? step.label :
          step.flow !== undefined ?
            <button type="button" {...dynamicFlowAction(onRunCommand, step.flow, step.args)}>{step.label}{step.id === "talk" ? <>{" "}<GuideKey shortcut="⌘K" /></> : null}</button> :
            step.label}
        {step.id === "set-up-job" ? tiles : null}
      </li>)}
    </ol>
  </section>
}

/**
 * The first-run card's live projection; no card row or model request. App.tsx
 * reads the same projection to hold Chat until the first job is registered.
 */
export function useFirstRun(commands?: readonly CatalogItem[]) {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    dismissed: session.firstRunDismissed, surface: session.surface, phase: session.phase, plugins: session.plugins, activeRepoKey: session.activeRepoKey, repositoryEntry: session.repositoryEntry,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: connectors } = useLiveQuery(collections.connectors)
  const { data: repositories } = useLiveQuery(collections.repositories)
  const { data: messages } = useLiveQuery(collections.messages)
  const { data: cards } = useLiveQuery(collections.cards)
  const { data: observations } = useLiveQuery(q => q.from({ observation: collections.repositoryJobObservations }).select(({ observation }) => observation))
  useLiveQuery(collections.workingCopies)
  useLiveQuery(collections.cloudWorkspaces)
  // Repository flow leaves change with this collection.
  const { data: repositoryCatalogs } = useLiveQuery(collections.repositoryFlows)
  const session = sessions[0]
  const dismissed = session?.dismissed ?? controller.store.session().firstRunDismissed ?? false
  const catalog = commands ?? controller.commands.all()
  const repo = activeRepositoryId(controller.store) ?? controller.repositoryFlows?.()?.repo ?? session?.repositoryEntry?.repo ?? undefined
  const identity = identities[0]
  const owner = identity?.state === "signed-in" ? identity.accountOwnerLogin ?? identity.login : null
  const binding = repo === undefined ? undefined : selectedBoxBinding(controller.store, repo)
  const selectedWorkspaceId = binding !== undefined && "workspaceId" in binding ? binding.workspaceId : null
  const readable = binding === undefined || "workspaceId" in binding
  const completedJobs = readable ? registeredRepositoryJobs(observations, repo, owner, selectedWorkspaceId) : new Set<RepositoryJob>()
  const steps = resolveSteps(catalog, {
    signedIn: identity?.state === "signed-in",
    localAuth: controller.localAuth !== undefined,
    cloud: cloudWebHost(controller.bootstrap),
    hasRepo: repositories.some(row => row.catalog !== true),
    hasSetup: completedJobs.size > 0,
    talked: messages.some(message => message.role === "user"),
  }, repo)
  const featuredFlows = repo === undefined ? [] : repositoryCatalogs.find(row => row.id === repo)?.flows ?? []
  const groups = firstRunGroups(catalog, {
    surface: session?.surface ?? "chat", typing: session?.phase === "responding", plugins: session?.plugins,
    signedOut: identity?.state === "signed-out", admin: identity?.admin === true,
    hasConnectors: identity?.state === "signed-in" || connectors.length > 0,
    publicRepo: activeCatalogRepositoryId(controller.store) !== null,
  }, featuredFlows)
  return {
    steps, groups, repo, dismissed, completedJobs,
    /** The last step offers at least one repository job tile. */
    jobTiles: groups.some(group => group.namespace === "repository"),
    /** No repository has no job to wait for; a repository's registrations are known once the host answers. */
    jobsKnown: repo === undefined || readable && repositoryJobsKnown(observations, repo, owner, selectedWorkspaceId),
    jobStates: repo === undefined || !readable ? undefined : repositoryJobStates(observations, cards, repo, owner, selectedWorkspaceId),
  }
}

export function SetupChecklist({ commands }: { commands?: readonly CatalogItem[] }) {
  const controller = useController()
  const { steps, groups, repo, dismissed, jobStates, completedJobs } = useFirstRun(commands)
  return <SetupChecklistCard steps={steps} groups={groups} repo={repo} dismissed={dismissed} jobStates={jobStates}
    completedJobs={completedJobs} onRunCommand={controller.runCommand} onDismiss={() => { controller.dismissFirstRun() }} />
}
