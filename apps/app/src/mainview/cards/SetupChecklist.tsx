import type { RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { dynamicFlowAction } from "../flows/FlowAction"
import { visible, type CatalogItem } from "../flows/registry"
import { activeRepositoryId } from "../state/RepoContext"
import { registeredRepositoryJobs, repositoryJobOf, repositoryJobStates } from "../state/RepositoryJobs"
import type { Card } from "../state/AppState"
import type { RunDynamicCommand } from "./CardFamily"
import { FIRST_RUN_JOBS } from "./FirstRunActions"
import "./SetupChecklist.css"

/*
 * The start-page checklist: what part of setup is done, and the one flow that
 * advances each remaining step. Completion is derived from live state — a step
 * checks itself off when the world says it happened, never when its button was
 * clicked. The list hides itself once every step is complete.
 */
export interface SetupProgress {
  readonly signedIn: boolean
  readonly localAuth?: boolean
  readonly hasRepo: boolean
  readonly hasSetup: boolean
}

interface SetupStep {
  readonly id: string
  readonly label: string
  /** The first of these flows registered on this host performs the step. */
  readonly flows: ReadonlyArray<string>
  readonly done: (state: SetupProgress) => boolean
}

export const SETUP_STEPS: ReadonlyArray<SetupStep> = [
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
  return SETUP_STEPS.map(step => {
    const flow = step.flows.find(name => catalog.some(item => item.name === name))
    return { id: step.id, label: step.id === "connect-github" && state.localAuth ? "Sign in" : step.label, complete: step.done(state), flow, args: flow === "issues.setup" ? repo : undefined }
  })
}

/** The repository's jobs as buttons: the third step, once that step is done. */
export interface ResolvedJob {
  readonly flow: string
  readonly label: string
  readonly repo?: string
  /** The job card's own word for its state; absent until a card has one. */
  readonly state?: string
}

export function resolveJobs(commands: readonly CatalogItem[], states: Partial<Record<RepositoryJob, string>>, repo?: string): ReadonlyArray<ResolvedJob> {
  const catalog = visible(commands)
  return FIRST_RUN_JOBS.flatMap(name => {
    const flow = catalog.find(item => item.name === name)
    const job = repositoryJobOf(name)
    return flow === undefined ? [] : [{ flow: name, label: flow.summary, repo, ...(job && states[job] !== undefined ? { state: states[job] } : {}) }]
  })
}

/** A host-confirmed registration for this account and repository, including paused jobs. */
export function hasRegisteredSetup(cards: Iterable<Card>, repo: string | undefined, owner: string | null): boolean {
  return registeredRepositoryJobs(cards, repo, owner).size > 0
}

export function SetupChecklistCard({ steps, jobs = [], onRunCommand }: {
  steps: ReadonlyArray<ResolvedStep>
  jobs?: ReadonlyArray<ResolvedJob>
  onRunCommand: RunDynamicCommand
}) {
  const done = steps.filter(step => step.complete).length
  const row = jobs.length === 0 ? null : <section className="setup-checklist-jobs" data-testid="repository-jobs" aria-label="Repository jobs">
    {jobs.map(job => <button type="button" key={job.flow} {...dynamicFlowAction(onRunCommand, job.flow, job.repo)}>{job.label}{job.state === undefined ? "" : ` · ${job.state}`}</button>)}
  </section>
  if (done === steps.length) return row
  return <section className="setup-checklist" data-testid="setup-checklist" aria-label="Set up Smithers">
    <header><h2>Set up Smithers</h2><span className="setup-checklist-count">{done} of {steps.length}</span></header>
    <progress value={done} max={steps.length}>{done} of {steps.length}</progress>
    <ol>
      {steps.map(step => <li key={step.id} data-complete={step.complete || undefined}>
        {step.complete ? step.id === "set-up-job" && row !== null ? row : <><span aria-hidden="true">✓</span>{step.label}</> :
          step.flow !== undefined ?
            <button type="button" {...dynamicFlowAction(onRunCommand, step.flow, step.args)}>{step.label}</button> :
            step.label}
      </li>)}
    </ol>
  </section>
}

/** Live session projection; no card row or model request. */
export function SetupChecklist({ commands }: { commands?: readonly CatalogItem[] }) {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    repositoryEntry: session.repositoryEntry, dismissed: session.firstRunDismissed,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: repositories } = useLiveQuery(collections.repositories)
  const { data: cards } = useLiveQuery(collections.cards)
  const repo = sessions[0]?.repositoryEntry?.repo ?? activeRepositoryId(controller.store) ?? undefined
  const identity = identities[0]
  const owner = identity?.state === "signed-in" ? identity.accountOwnerLogin ?? identity.login : null
  const steps = resolveSteps(commands ?? controller.commands.all(), {
    signedIn: identities[0]?.state === "signed-in",
    localAuth: controller.localAuth !== undefined,
    hasRepo: repositories.some(row => row.catalog !== true),
    hasSetup: hasRegisteredSetup(cards, repo, owner),
  }, repo)
  // Undismissed, the recommended actions carry the same five; the row is theirs until then.
  const dismissed = sessions[0]?.dismissed ?? controller.store.session().firstRunDismissed
  const jobs = dismissed && steps[2]?.complete === true && repo !== undefined
    ? resolveJobs(commands ?? controller.commands.all(), repositoryJobStates(cards, repo, owner), repo) : []
  return <SetupChecklistCard steps={steps} jobs={jobs} onRunCommand={controller.runCommand} />
}
