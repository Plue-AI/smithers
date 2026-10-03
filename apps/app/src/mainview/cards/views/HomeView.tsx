import { useCallback } from "react"
import { GitBranch } from "lucide-react"
import { useClock } from "@smthrs/ui/clock"
import type { HomeViewProps } from "@smthrs/rpc/HomeCard"
import { ActorChip, actorName } from "./ActorChip"
import { HomeActionView } from "./HomeActionView"
import { HomeRowView, HomeFilterView } from "./HomeRowView"

export function HomeView({ model, actions, view, onAction, onView }: HomeViewProps) {
  const now = useClock(true, 1000)
  const observe = useCallback((element: HTMLElement | null) => {
    if (!element || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) onView({ on_screen: entry.isIntersecting })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onView])
  const age = Math.max(0, Math.floor((now - Date.parse(model.main.last_success_at)) / 1000))
  const synced = age < 60 ? `synced ${age} s ago` : `synced ${Math.round(age / 60)} min ago`
  const syncActions = actions.filter(action => action.label === "Retry" || action.label === "Fix")
  const otherActions = actions.filter(action => action.label !== "Retry" && action.label !== "Fix")
  const filters = []
  for (const state of ["needs_you", "working", "queued", "in_review"] as const) filters.push(<HomeFilterView key={state} state={state} count={model.counts[state] + (state === "working" ? model.counts.starting : 0)} view={view} onView={onView} />)
  const attention = []
  for (const [index, row] of model.attention.entries()) {
    const controls = []
    for (const [index, action] of row.actions.entries()) controls.push(<HomeActionView key={index} action={action} onAction={onAction} />)
    attention.push(<div key={index} className="mvp-home-attention"><span>{row.text}</span>{controls}</div>)
  }
  const syncControls = [], otherControls = [], rows = [], runs = []
  for (const [index, action] of syncActions.entries()) syncControls.push(<HomeActionView key={index} action={action} onAction={onAction} />)
  for (const [index, action] of otherActions.entries()) otherControls.push(<HomeActionView key={index} action={action} onAction={onAction} />)
  for (const item of model.items) if (!view.filter || item.state === view.filter || (view.filter === "working" && item.state === "starting")) rows.push(<HomeRowView key={item.n} item={item} now={now} onAction={onAction} />)
  for (const run of model.background_runs) {
    const controls = []
    for (const [index, action] of run.actions.entries()) controls.push(<HomeActionView key={index} action={action} onAction={onAction} />)
    runs.push(<li key={run.id} className="mvp-run-row" data-state={run.state}><span>{run.title}</span><span className="mvp-meta">{run.detail ?? (run.state === "queued" ? "Queued" : run.state === "running" ? "Running" : run.state === "waiting" ? "Waiting" : "Failed")}</span><span className="mvp-row-end">{controls}</span></li>)
  }
  return <section ref={observe} className="mvp-home smithers-card" data-keyboard-pane="Stack" aria-label={model.repository}>
    <h2>{model.repository}</h2>
    {attention}
    <div className="mvp-filters">{filters}</div>
    <ol className="mvp-stack" aria-label="Stack"><li className="mvp-stack-main-row"><span className="mvp-stack-node"><GitBranch size={14} /></span>
      <span className="mvp-stack-trunk">main <span title={model.main.sha}>{model.main.title}</span>{model.merged_since_last_look.length ? <span className="mvp-merged-since">{model.merged_since_last_look.length} merged since you looked</span> : null}</span>
      <span className="mvp-sync" data-stale={model.main.health !== "fresh" || undefined} data-health={model.main.health}>
        {model.main.health === "fresh" ? synced : model.main.health === "stale" ? `${synced}${model.main.cause ? ` · ${model.main.cause}` : ""}` : model.main.cause}
        {model.main.retry_at ? ` · retries at ${model.main.retry_at}` : null}{syncControls}</span></li>
      {rows}</ol>
    {runs.length ? <ul className="mvp-runs" aria-label="Background runs">{runs}</ul> : null}
    <div className="mvp-actions"><div className="mvp-machines" aria-label={`${model.machines.in_use} of ${model.machines.capacity} machines in use`}>{model.machines.slots.map((slot, index) => <span key={index} className="mvp-machine" data-used title={`${slot.branch} · ${actorName(slot.actor)}`}><ActorChip actor={slot.actor} size="s" live={slot.awake} /></span>)}{Array.from({ length: Math.max(0, model.machines.capacity - model.machines.slots.length) }, (_, index) => <span className="mvp-machine" key={`free-${index}`} title="Free" />)}<span className="mvp-machines-label">{model.machines.in_use}/{model.machines.capacity} machines</span></div><span className="mvp-actions-end">{otherControls}</span></div>
  </section>
}
