import type { RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { dynamicFlowAction, flowAction } from "../flows/FlowAction"
import { repositoryFlowName } from "../flows/entries/flow"
import { unmetRequirements,visible,type CatalogItem,type CommandState } from "../flows/registry"
import { accountOwnerOf } from "../state/AccountOwner"
import { activeCatalogRepositoryId, activeRepositoryId } from "../state/RepoContext"
import { repositoryJobOf, repositoryJobStates } from "../state/RepositoryJobs"
import type { RepositoryFlow } from "../state/AppState"
import type { RunDynamicCommand } from "./CardFamily"
import "./FirstRunActions.css"

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
  return picture === undefined ? null : <svg className="first-run-picture" viewBox="0 0 100 60" aria-hidden="true" dangerouslySetInnerHTML={{ __html: picture }} />
}

export function FirstRunActionsCard({ commands, state, repo, featuredFlows = [], jobStates, onRunCommand: dispatchFlow, onDismiss }: {
  commands: readonly CatalogItem[]
  state: CommandState
  repo?: string
  featuredFlows?: ReadonlyArray<RepositoryFlow>
  jobStates?: Partial<Record<RepositoryJob, string>>
  onRunCommand: RunDynamicCommand
  onDismiss: () => void
}) {
  // Every job stays one button away: only the dismissal closes the card.
  const onRunCommand: RunDynamicCommand = (flow, args) => {
    if (flow === "app.first-run.dismiss") return onDismiss()
    dispatchFlow(flow, args)
  }
  // A job with a recorded state is one the person has set up: it checks off (Will, 2026-09-20).
  return <section className="first-run-actions" data-testid="first-run-actions" aria-label="Learn how to">
    <header><h2>Learn how to</h2><button type="button" aria-label="Dismiss" {...flowAction(onRunCommand, "app.first-run.dismiss")}>×</button></header>
    {firstRunGroups(commands, state, featuredFlows).map(group => <section key={group.namespace} aria-label={group.label}>
      {group.flows.map(flow => <button type="button" key={flow.name}
        data-done={group.namespace === "repository" && jobState(jobStates, flow.name) !== null || undefined}
        {...dynamicFlowAction(onRunCommand, flow.name, repo)}>
        <JobPicture flow={flow.name} />{flow.summary}{group.namespace === "repository" ? jobState(jobStates, flow.name) : null}</button>)}
    </section>)}
  </section>
}

/** Live session projection; no card row or model request. */
export function FirstRunActions({ commands }: { commands?: readonly CatalogItem[] }) {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    dismissed: session.firstRunDismissed, surface: session.surface, phase: session.phase, plugins: session.plugins, activeRepoKey: session.activeRepoKey, repositoryEntry: session.repositoryEntry,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: connectors } = useLiveQuery(collections.connectors)
  const { data: cards } = useLiveQuery(collections.cards)
  useLiveQuery(collections.repositories)
  // Repository flow leaves change with this collection.
  const { data: repositoryCatalogs } = useLiveQuery(collections.repositoryFlows)
  const session = sessions[0]
  if (session?.dismissed ?? controller.store.session().firstRunDismissed) return null
  const identity = identities[0]
  const repo = activeRepositoryId(controller.store) ?? controller.repositoryFlows?.()?.repo ?? session?.repositoryEntry?.repo ?? undefined
  const owner = accountOwnerOf(identity) ?? null
  const featuredFlows = repo === undefined ? [] : repositoryCatalogs.find(row => row.id === repo)?.flows ?? []
  return <FirstRunActionsCard commands={commands ?? controller.commands.all()}
    featuredFlows={featuredFlows}
    repo={repo} jobStates={repo === undefined ? undefined : repositoryJobStates(cards, repo, owner)} state={{
    surface: session?.surface ?? "chat", typing: session?.phase === "responding", plugins: session?.plugins,
    signedOut: identity?.state === "signed-out", admin: identity?.admin === true,
    hasConnectors: identity?.state === "signed-in" || connectors.length > 0,
    publicRepo: activeCatalogRepositoryId(controller.store) !== null,
  }} onRunCommand={controller.runCommand} onDismiss={() => {
    controller.dismissFirstRun()
  }} />
}
