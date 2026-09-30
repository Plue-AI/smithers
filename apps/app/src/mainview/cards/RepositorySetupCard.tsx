import { flowAction, flowProps } from "../flows/FlowAction"
import { setupActivationProblems, storedSetupCandidate, type RepositoryJob, type RepositorySetup, type SetupReceipt } from "@smthrs/rpc/RepositorySetup"
import { useLiveQuery } from "@tanstack/react-db"
import { flowArgs } from "../flows/FlowArgs"
import { repositoryCiConfigured, repositoryJobState } from "../state/RepositoryJobs"
import { selectedBoxBindingFrom } from "../state/RepoContext"
import { setupFailureSentence, setupVerdict } from "../state/RunFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { setupTrialPr } from "../state/RepositorySetupTrial"
import type { CardFamily, CardOf, CardProjectionAuthority, RunCommand } from "./CardFamily"
import "./RepositorySetupCard.css"

const modeNames = { automatic: "Automatic", manual: "Manual", approved: "Approved trigger", off: "Off" }
const views: ReadonlyArray<{ id: RepositorySetup["view"]; name: string }> = [
  { id: "flows", name: "Flows" }, { id: "prompts", name: "Prompts" }, { id: "checks", name: "Checks" }, { id: "evals", name: "Evals" }, { id: "test", name: "Test" }
]
const jobActions: Record<RepositoryJob, { trial: string; enable: string; update: string; title: string; body: string; scope: string }> = {
  issues: { trial: "Create test issue", enable: "Enable issue handling", update: "Update issue handling", title: "Test issue title", body: "Test issue body", scope: "This test issue only" },
  review: { trial: "Review test PR", enable: "Enable PR reviews", update: "Update PR reviews", title: "Test PR", body: "Review trial input", scope: "This test PR only" },
  ci: { trial: "Test CI checks", enable: "Enable CI checks", update: "Update CI checks", title: "CI trial", body: "Change to check", scope: "This test change only" },
  feature: { trial: "Try feature flow", enable: "Enable feature flow", update: "Update feature flow", title: "Test feature", body: "Feature request", scope: "This test feature only" },
  chores: { trial: "Run test chore", enable: "Enable chore", update: "Update chore", title: "Test chore", body: "Routine maintenance", scope: "This test chore only" }
}

/* An earlier operation's failure, keyed by the operation; its host receipt's words stay behind Details. */
const PREVIOUS_FAILURES: Readonly<Record<SetupReceipt["operation"], UserFailureCopy>> = {
  inspect: { fault: "infra", sentence: "Smithers could not inspect this draft. Not your fault.", actions: [] },
  evaluate: { fault: "infra", sentence: "Smithers could not run these evals. Not your fault.", actions: [] },
  trial: { fault: "infra", sentence: "Smithers could not run this test. Not your fault.", actions: [] },
  apply: { fault: "infra", sentence: "Smithers could not apply this draft. Not your fault.", actions: [] },
  pause: { fault: "infra", sentence: "Smithers could not pause this flow. Not your fault.", actions: [] },
  run: { fault: "infra", sentence: "Smithers could not run this flow. Not your fault.", actions: [] }
}

/* A receipt code the person answers keeps its setup sentence; any other failure reads its operation's copy. */
const previousFailure = (receipt: SetupReceipt & { readonly error: string }) => {
  const verdict = setupVerdict(receipt.error)
  const copy: UserFailureCopy = verdict?.fault === "user" ? { fault: "user", sentence: verdict.message, actions: [] } : PREVIOUS_FAILURES[receipt.operation]
  return describedFailure(`setup.${receipt.operation}`, copy, receipt.error)
}

// Keep the most recent edit until its durable projection arrives, including
// after blur. Earlier writes in the queue are not edits from another source.
const pendingEditorValues = new WeakMap<HTMLInputElement | HTMLTextAreaElement, string>()
const editor = (value: string | number) => ({
  defaultValue: value,
  onInputCapture: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    pendingEditorValues.set(event.currentTarget, event.currentTarget.value)
  },
  ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!node) return
    const pending = pendingEditorValues.get(node)
    if (pending !== undefined) {
      if (String(value) !== pending) return
      pendingEditorValues.delete(node)
    }
    if (node.ownerDocument.activeElement !== node && node.value !== String(value)) node.value = String(value)
  }
})

/** Settings and chat edit the same persisted candidate; only host receipts activate it. */
export function RepositorySetupCard({ card, onRunCommand, signedOut, ciConfigured }: { card: CardOf<"repository-setup">; onRunCommand: RunCommand; signedOut?: boolean; ciConfigured?: boolean }) {
  const state = card.payload
  const draft = state.draft
  const preview = signedOut ?? state.owner === null
  const canRun = !preview
  const labels = jobActions[state.job]
  const needsTrialPr = state.job === "review" || state.job === "ci"
  const trialPr = setupTrialPr(draft.trialBody)
  const recovering = state.recovery?.state === "requested"
  const unknown = state.recovery !== undefined && state.recovery.registrationState !== "known"
  const pending = recovering || state.request?.state === "requested" || state.request?.state === "running"
  const owned = state.active?.owned !== false
  const set = (field: string, value: unknown) => onRunCommand("setup.configure", flowArgs("setup.configure", { cardId: card.id, field, value }))
  const view = (next: RepositorySetup["view"], step?: string) => onRunCommand("setup.view", flowArgs("setup.view", { cardId: card.id, view: next, ...(step ? { step } : {}) }))
  const selected = draft.steps.find(step => step.id === state.selectedStep) ?? draft.steps[0]
  const gate = [...((state.job === "issues" || state.job === "review") && draft.replies !== "draft" ? ["Choose draft replies."] : []), ...setupActivationProblems(state)]
  const activeMatches = owned && !unknown && state.active?.enabled && state.active.revision === state.revision && storedSetupCandidate(state, state.active.digest)
  const drafted = owned && !unknown && state.active?.enabled === true && state.active.draft !== undefined && !activeMatches
  const schedule = state.job === "chores" && !unknown && state.active?.enabled && state.active.schedule?.expression === draft.schedule
    && Date.parse(state.active.schedule.nextFireAt) > Date.now() ? state.active.schedule : undefined
  const manual = state.manualDraft
  const workStep = draft.steps.find(step => step.id === manual?.stepId)
  const needsSubject = state.job === "issues" || state.job === "review" || state.job === "ci"
  const workKind = state.job === "issues" ? "issue" : "pr"
  const work = (field: "prompt" | "source" | "number", value: unknown) => onRunCommand("setup.work", flowArgs("setup.work", { cardId: card.id, stepId: manual!.stepId, field, value }))
  const updateCheck = (id: string, key: string, value: unknown) => set(`check.${id}.${key}`, value)
  const receipt = state.receipt?.requestId === state.request?.id ? state.receipt : undefined
  const runAccess = (observed: SetupReceipt) => observed.runId && state.workspaceId && <div className="setup-actions">
    <button type="button" {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId: observed.runId!, repo: state.repo, sourceCard: card.id }))}>{observed.jobRunId ? "Setup run" : "Run"}</button>
    {observed.jobRunId && <button type="button" {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId: observed.jobRunId!, repo: state.repo, sourceCard: card.id }))}>Job run</button>}
  </div>
  return <div className="repository-setup" data-testid={`setup-${state.job}`}>
    <div className="setup-heading"><span>{state.repo}</span><span>{repositoryJobState(state) ?? ""}</span></div>
    <nav className="setup-tabs" aria-label="Setup views">{views.map(tab => <button type="button" key={tab.id} aria-current={state.view === tab.id ? "page" : undefined} {...flowAction(onRunCommand, "setup.view", flowArgs("setup.view", { cardId: card.id, view: tab.id }))}>{tab.name}</button>)}</nav>
    {state.view === "flows" && <>
      {draft.steps.map(step => <div className="setup-step" key={step.id}>
        <button type="button" {...flowAction(onRunCommand, "setup.view", flowArgs("setup.view", { cardId: card.id, view: "prompts", step: step.id }))}>{step.name}</button>
        <label><span className="setup-sr-only">When to run {step.name}</span><select value={step.mode} onChange={event => set(`step.${step.id}.mode`, event.target.value)}>
          {Object.entries(modeNames).map(([mode, name]) => <option key={mode} value={mode}>{name}</option>)}
        </select></label>
        {canRun && owned && !unknown && state.active?.enabled && step.mode !== "off" && <button type="button" aria-label={`Run ${step.name}`} {...flowAction(onRunCommand, "setup.work", flowArgs("setup.work", { cardId: card.id, stepId: step.id }))}>Run</button>}
      </div>)}
      <div className="setup-fields">
        {(state.job === "issues" || state.job === "review") && <label>Replies<select value={draft.replies} onChange={event => set("replies", event.target.value)}><option value="draft">Draft for approval</option>{draft.replies === "automatic" && <option value="automatic" disabled>Automatic (unavailable)</option>}</select></label>}
        <label>Landing<select value={draft.landing} onChange={event => set("landing", event.target.value)}><option value="ask">Ask me</option><option value="checks">When approved checks pass</option></select></label>
        <label>Time limit (minutes)<input type="number" min={1} max={360} {...editor(draft.budgetMinutes)} onInput={event => { if (event.currentTarget.value) set("budgetMinutes", Number(event.currentTarget.value)) }} /></label>
        {state.job === "issues" && <label>Apply to<select value={draft.scope} onChange={event => set("scope", event.target.value)}><option value="future">New and edited issues</option><option value="label">Chosen issue label</option></select></label>}
        {(draft.scope === "label" || (state.job === "chores" && draft.choreEvent === "labeled")) && <label>Issue label<input {...editor(draft.label)} onInput={event => set("label", event.currentTarget.value)} /></label>}
        {state.job === "chores" && <label>Schedule (UTC)<input {...editor(draft.schedule)} placeholder="Cron expression; blank for manual" onInput={event => set("schedule", event.currentTarget.value)} /></label>}
        {state.job === "chores" && <label>Also run on<select aria-label="Also run on" value={draft.choreEvent} onChange={event => set("choreEvent", event.target.value)}>
          <option value="none">Nothing</option><option value="push">Push to the default branch</option><option value="labeled">Labeled issue</option>
        </select></label>}
        {schedule && <div className="setup-field"><span>Next run</span><time dateTime={schedule.nextFireAt}>{new Date(schedule.nextFireAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}</time></div>}
      </div>
      {state.sources.length > 0 && <details><summary>Repository evidence</summary><ul>{state.sources.map((source, index) => <li key={`${source.path}:${index}`}><code>{source.path}</code> · {source.status === "missing" ? "not found" : source.status}{source.status !== "missing" && source.summary.toLowerCase() !== source.status && <div>{source.summary}</div>}</li>)}</ul></details>}
      {canRun && <div className="setup-actions"><button type="button" {...flowAction(onRunCommand, "setup.guide", card.id)}>Configure in Chat</button>
        <button type="button" disabled={pending} {...flowAction(onRunCommand, "setup.run", flowArgs("setup.run", { cardId: card.id, operation: "inspect" }))}>Inspect repository</button></div>}
      {ciConfigured === false && (state.job === "issues" || state.job === "feature") && <div className="setup-actions"><button type="button" {...flowAction(onRunCommand, "ci.setup", state.repo)}>Set up CI</button></div>}
    </>}
    {state.view === "work" && manual && workStep && <>
      <label className="setup-field">Flow<select value={manual.stepId} onChange={event => onRunCommand("setup.work", flowArgs("setup.work", { cardId: card.id, stepId: event.target.value }))}>{draft.steps.filter(step => step.mode !== "off").map(step => <option key={step.id} value={step.id}>{step.name}</option>)}</select></label>
      {needsSubject && <div className="setup-fields">
        <label>Source<select aria-label="Source" value={manual.source} onChange={event => work("source", event.target.value)}><option value="github">GitHub</option><option value="smithers-cloud">Smithers</option></select></label>
        <label>{workKind === "issue" ? "Issue number" : "PR number"}<input aria-label={workKind === "issue" ? "Issue number" : "PR number"} type="number" min={1} {...editor(manual.number ?? "")} onInput={event => work("number", event.currentTarget.value ? Number(event.currentTarget.value) : null)} /></label>
      </div>}
      <label className="setup-field">{needsSubject ? "Instructions (optional)" : "Work request"}<textarea aria-label={needsSubject ? "Instructions (optional)" : "Work request"} rows={4} {...editor(manual.prompt)} onInput={event => work("prompt", event.currentTarget.value)} /></label>
      {canRun && <button type="button" disabled={pending || !activeMatches || workStep.mode === "off" || (needsSubject ? !manual.number : !manual.prompt.trim())}
        {...flowAction(onRunCommand, "setup.run", flowArgs("setup.run", { cardId: card.id, operation: "run" }))}>{workStep.name}</button>}
      {!activeMatches && <span className="setup-gate">Test and apply this draft first.</span>}
    </>}
    {state.view === "prompts" && selected && <>
      <label className="setup-field">Flow<select value={selected.id} onChange={event => view("prompts", event.target.value)}>{draft.steps.map(step => <option key={step.id} value={step.id}>{step.name}</option>)}</select></label>
      <label className="setup-field">Prompt<textarea {...editor(selected.prompt)} rows={9} onInput={event => set(`step.${selected.id}.prompt`, event.currentTarget.value)} /></label>
    </>}
    {state.view === "checks" && <>
      {draft.checks.map(check => <fieldset key={check.id}><legend>{check.kind === "ai" ? "AI check" : "Command"}</legend>
        <label className="setup-field">Name<input {...editor(check.name)} onInput={event => updateCheck(check.id, "name", event.currentTarget.value)} /></label>
        <label className="setup-field">{check.kind === "ai" ? "Rule" : "Command"}<textarea rows={check.kind === "ai" ? 5 : 2} {...editor(check.rule)} onInput={event => updateCheck(check.id, "rule", event.currentTarget.value)} /></label>
        <label className="setup-field">Paths<input {...editor(check.paths.join(", "))} onInput={event => updateCheck(check.id, "paths", event.currentTarget.value.split(",").map(path => path.trim()).filter(Boolean))} /></label>
        <div className="setup-actions"><label>Policy<select value={check.policy} onChange={event => updateCheck(check.id, "policy", event.target.value)}><option value="report">Report findings</option><option value="required">Required before landing</option></select></label>
          <button type="button" {...flowAction(onRunCommand, "setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "checks.remove", value: check.id }))}>Remove check</button></div>
      </fieldset>)}
      <div className="setup-actions">{(["command", "ai"] as const).map(kind => <button key={kind} type="button" {...flowProps("setup.configure")} onClick={() => onRunCommand("setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "checks.add", value: { id: crypto.randomUUID(), name: kind === "ai" ? "Observability" : "Repository check", kind, rule: "", paths: [], policy: "report" } }))}>Add {kind === "ai" ? "AI check" : "command"}</button>)}</div>
    </>}
    {state.view === "evals" && <>
      {draft.cases.map(test => {
        const observed = state.evaluation?.results.find(result => result.caseId === test.id)
        return <details key={test.id}><summary>{test.name}{observed ? ` · ${observed.status}` : ""}</summary>
          <label className="setup-field">Case<textarea rows={2} {...editor(test.input)} onInput={event => set(`case.${test.id}.input`, event.currentTarget.value)} /></label>
          <label className="setup-field">Expected<textarea rows={3} {...editor(test.expected)} onInput={event => set(`case.${test.id}.expected`, event.currentTarget.value)} /></label>
          {observed && <div><p>{observed.observed}</p><ul>{observed.evidence.map((evidence, index) => <li key={index}><code>{evidence}</code></li>)}</ul></div>}
        </details>
      })}
      {canRun && <button type="button" disabled={pending || !draft.cases.length} {...flowAction(onRunCommand, "setup.run", flowArgs("setup.run", { cardId: card.id, operation: "evaluate" }))}>Run evals</button>}
      {state.previousReceipts.length > 0 && <details><summary>Previous results</summary>{state.previousReceipts.map(previous => <details key={previous.requestId}>
        <summary>Draft {previous.revision} · {previous.operation} · {previous.phase}</summary>
        {runAccess(previous)}
        {previous.results.map(result => <div key={result.caseId}><strong>{result.caseId} · {result.status}</strong><p>{result.observed}</p><ul>{result.evidence.map((evidence, index) => <li key={index}><code>{evidence}</code></li>)}</ul></div>)}
        {previous.error && <FailureNotice role="status" className="setup-previous-error" data-testid="setup-previous-failure"
          failure={previousFailure({ ...previous, error: previous.error })} />}
        {previous.evidence.length > 0 && <ul>{previous.evidence.map((evidence, index) => <li key={index}><code>{evidence}</code></li>)}</ul>}
      </details>)}</details>}
    </>}
    {state.view === "test" && <>
      <label className="setup-field">{labels.title}<input aria-label={labels.title} {...editor(draft.trialTitle)} onInput={event => set("trialTitle", event.currentTarget.value)} /></label>
      {needsTrialPr ? <div className="setup-fields">
        <label>Source<select aria-label="Source" value={trialPr.source} onChange={event => set("trial.source", event.target.value)}><option value="github">GitHub</option><option value="smithers-cloud">Smithers</option></select></label>
        <label>PR number<input aria-label="PR number" type="number" min={1} {...editor(trialPr.number ?? "")} onInput={event => set("trial.number", event.currentTarget.value ? Number(event.currentTarget.value) : null)} /></label>
      </div> : <label className="setup-field">{labels.body}<textarea aria-label={labels.body} rows={4} {...editor(draft.trialBody)} onInput={event => set("trialBody", event.currentTarget.value)} /></label>}
      <div className="setup-heading"><span>{labels.scope}</span>{(state.job === "issues" || state.job === "review") && <span>Replies drafted</span>}</div>
      {canRun && <button type="button" disabled={pending || (needsTrialPr && !trialPr.number)} {...flowAction(onRunCommand, "setup.run", flowArgs("setup.run", { cardId: card.id, operation: "trial" }))}>{labels.trial}</button>}
      {state.trial && <div aria-live="polite">{(!canRun || !pending || state.trial.requestId !== state.request?.id) && <p>{state.trial.phase}</p>}{state.trial.trialIssue && (state.trial.trialIssue.url
        ? <a href={state.trial.trialIssue.url} target="_blank" rel="noreferrer">{state.trial.trialIssue.url.includes("/pull/") ? "PR" : "Issue"} #{state.trial.trialIssue.number}</a>
        : <button type="button" {...flowAction(onRunCommand, "issues.view", flowArgs("issues.view", { number: state.trial!.trialIssue!.number, repo: state.repo, source: state.trial!.trialIssue!.source }))}>Issue #{state.trial.trialIssue.number}</button>)}
        {state.trial.evidence.length > 0 && <details><summary>Technical details</summary><ul>{state.trial.evidence.map((evidence, index) => <li key={index}><code>{evidence}</code></li>)}</ul></details>}
      </div>}
    </>}
    {receipt && runAccess(receipt)}
    {(state.request?.state === "failed" || state.recovery?.state === "failed") && <div role="alert" className="setup-error"><p>{state.recovery?.error ?? setupFailureSentence(state.request?.error) ?? state.request?.error}</p>{canRun && <button type="button" disabled={recovering} {...flowAction(onRunCommand, "setup.retry", card.id)}>{receipt && !["completed", "failed", "stopped"].includes(receipt.phase) ? "Reconnect" : "Retry"}</button>}</div>}
    <footer className="setup-actions" aria-live="polite">
      {preview ? <button type="button" {...flowAction(onRunCommand, "auth.prompt")}>Sign in</button> : <>
        {pending && <span>{recovering ? "Requested" : receipt?.phase === "waiting" ? "Waiting" : receipt?.phase === "running" ? "Running" : receipt?.phase === "queued" ? "Queued" : "Requested"}</span>}
        {pending && receipt?.phase === "queued" && receipt.error && <span className="setup-gate">{receipt.error}</span>}
        {owned && !unknown && state.active?.enabled && <button type="button" disabled={pending} {...flowAction(onRunCommand, "setup.run", flowArgs("setup.run", { cardId: card.id, operation: "pause" }))}>Pause</button>}
        {drafted && <button type="button" disabled={pending} {...flowAction(onRunCommand, "setup.discard", card.id)}>Discard draft</button>}
        <button type="button" disabled={pending || unknown || !owned || gate.length > 0 || (state.active?.enabled && state.active.revision === state.revision)} {...flowAction(onRunCommand, "setup.run", flowArgs("setup.run", { cardId: card.id, operation: "apply" }))}>{state.active?.enabled ? labels.update : labels.enable}</button>
        {gate.length > 0 && !activeMatches && <span className="setup-gate">{gate[0]}</span>}
      </>}
    </footer>
  </div>
}

function ObservedRepositorySetup({ collections, ...props }: Parameters<typeof RepositorySetupCard>[0] & {
  collections: { [K in "repositoryJobObservations" | "sessions" | "workingCopies" | "cloudWorkspaces"]: NonNullable<CardProjectionAuthority["collections"][K]> }
}) {
  const { data } = useLiveQuery(q => q.from({ observation: collections.repositoryJobObservations }).select(({ observation }) => observation))
  const { data: sessions } = useLiveQuery(collections.sessions)
  useLiveQuery(collections.workingCopies)
  useLiveQuery(collections.cloudWorkspaces)
  const binding = selectedBoxBindingFrom(collections, sessions[0]?.activeRepoKey, props.card.payload.repo)
  const mismatch = binding !== undefined && ("error" in binding || (props.card.payload.workspaceId !== undefined && props.card.payload.workspaceId !== binding.workspaceId))
  return <RepositorySetupCard {...props} ciConfigured={mismatch ? undefined : repositoryCiConfigured(data, props.card.payload.repo, props.card.payload.owner, binding !== undefined && "workspaceId" in binding ? binding.workspaceId : null)} />
}

export const repositorySetupCardFamily: CardFamily<"repository-setup"> = {
  "repository-setup": { render: (card, actions) => {
    const collections = actions.projectionStore?.collections
    return collections?.repositoryJobObservations && collections.sessions && collections.workingCopies && collections.cloudWorkspaces
      ? <ObservedRepositorySetup card={card} collections={{ repositoryJobObservations: collections.repositoryJobObservations, sessions: collections.sessions, workingCopies: collections.workingCopies, cloudWorkspaces: collections.cloudWorkspaces }} onRunCommand={actions.onRunCommand} signedOut={actions.signedOut} />
      : <RepositorySetupCard card={card} onRunCommand={actions.onRunCommand} signedOut={actions.signedOut} />
  }, pill: () => "" }
}
