/*
 * The Flow card (mvp.md §6.12, J5): a flow's steps, with its versions told
 * apart. Active is what new TODOs use; Proposed is a TODO in the stack;
 * "Merged · active after sync" is the moment between merge and load; a merged
 * flow that fails to load reads "Merged · not active" in ember and the
 * previous version stays Active. Runs keep the version they started with.
 */
import { Button } from "@smthrs/ui"
import { Check, GitPullRequest, Hourglass, Loader, Lock, TriangleAlert } from "lucide-react"
import { Card } from "../parts"
import { useFrame } from "../frame"
import type { FlowVersion } from "../world"
import type { ExtraCardProps } from "./extra"

const VersionChip = ({ version, selected }: { readonly version: FlowVersion; readonly selected: boolean }) => {
  const { state: { world } } = useFrame()
  const todo = version.todo === undefined ? undefined : world.todos.find(each => each.id === version.todo)
  const icon = version.state === "active" ? <Check size={13} aria-hidden="true" />
    : version.state === "proposed" ? <GitPullRequest size={13} aria-hidden="true" />
    : version.state === "merged-syncing" ? <Loader size={13} className="mvp-run-icon" aria-hidden="true" />
    : version.state === "merged-failed" ? <TriangleAlert size={13} aria-hidden="true" /> : null
  const word = version.state === "active" ? "Active" : version.state === "proposed" ? "Proposed"
    : version.state === "merged-syncing" ? "Merged · active after sync" : version.state === "merged-failed" ? "Merged · not active" : "Previous"
  return (
    <button type="button" className="mvp-version" data-state={version.state} aria-pressed={selected} data-mock={`version-${version.id}`}>
      {icon}<span>{word}</span>{todo?.pr === undefined ? null : <span className="mvp-version-pr">#{todo.pr}</span>}
    </button>
  )
}

/* System flows (mvp.md M-30) are read-only: no Source, no Change. */
const SYSTEM: Record<string, { title: string; steps: ReadonlyArray<{ title: string; detail: string }> }> = {
  merge: { title: "Merge flow", steps: [
    { title: "Check the approval", detail: "A person's approval of this exact revision" },
    { title: "Merge on GitHub", detail: "One commit onto main" },
    { title: "Rebase the stack", detail: "Later items move onto the new main" },
    { title: "Learn", detail: "A learning run reads what happened" }
  ] }
}

export const FlowCard = ({ id, target, view }: ExtraCardProps) => {
  const { state: { world, seq } } = useFrame()
  const system = SYSTEM[target]
  if (system !== undefined) {
    return (
      <Card id={id} kind="flow" title={system.title} status={<span className="mvp-locked"><Lock size={12} aria-hidden="true" />System</span>}>
        <ol className="mvp-flow-steps">
          {system.steps.map((step, index) => (
            <li key={step.title}><span className="mvp-flow-n">{index + 1}</span><span className="mvp-flow-title">{step.title}</span><span className="mvp-flow-detail">{step.detail}</span></li>
          ))}
        </ol>
      </Card>
    )
  }
  const versions = world.flowVersions.filter(each => each.state !== "previous")
  const selected = versions.find(each => each.id === view) ?? versions.find(each => each.state === "active") ?? versions[0]
  if (selected === undefined) return null
  const active = world.flowVersions.find(each => each.state === "active")
  const added = new Set(selected.steps.map(step => step.id).filter(step => active?.steps.every(each => each.id !== step) ?? false))
  const changed = new Set(selected.steps.filter(step => {
    const before = active?.steps.find(each => each.id === step.id)
    return before !== undefined && selected.state !== "active" && (before.title !== step.title || before.detail !== step.detail)
  }).map(step => step.id))
  return (
    <Card id={id} kind="flow" title="TODO flow">
      <div className="mvp-versions" role="group" aria-label="Versions">
        {versions.map(version => <VersionChip key={version.id} version={version} selected={version.id === selected.id} />)}
      </div>
      <p className="mvp-flow-path"><span className="mvp-mono">{selected.label}</span></p>
      <ol className="mvp-flow-steps">
        {selected.steps.map((step, index) => (
          <li key={step.id} data-added={added.has(step.id) || undefined} data-changed={changed.has(step.id) || undefined} data-fresh={step.seq === seq || undefined}>
            <span className="mvp-flow-n">{index + 1}</span>
            <span className="mvp-flow-title">{step.title}</span>
            {step.detail === undefined ? null : <span className="mvp-flow-detail">{step.detail}</span>}
          </li>
        ))}
        <li className="mvp-flow-wait" data-mock="flow-wait">
          <span className="mvp-flow-n"><Hourglass size={12} aria-hidden="true" /></span>
          <span className="mvp-flow-title">Wait for merge</span>
          <span className="mvp-flow-signals">
            <span className="mvp-signal">rebase <span aria-hidden="true">↺</span> Verify</span>
            <span className="mvp-signal">steer <span aria-hidden="true">↺</span> Implement</span>
          </span>
        </li>
      </ol>
      {selected.state === "merged-failed" ? <p className="mvp-failure-line"><TriangleAlert size={14} aria-hidden="true" /><b>Load failed</b><span>{selected.error}</span></p> : null}
      {selected.state === "active" && versions.length === 1 ? (
        <div className="mvp-actions"><span className="mvp-actions-end"><Button size="sm" variant="ghost" data-mock="flow-edit">Change</Button></span></div>
      ) : null}
    </Card>
  )
}
