import { useCallback, useRef } from "react"
import { GitBranch, MoreHorizontal } from "lucide-react"
import { useClock } from "@smthrs/ui/clock"
import type { Action } from "@smthrs/rpc/CardAction"
import type { HomeItem, HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { TodoState } from "@smthrs/rpc/CardPrimitives"
import { ActorChip, actorName } from "./ActorChip"
import { LessonsCount } from "./ProposalView"
import { StateWord } from "./StateWord"

/** Supplied actions preserve their order, arguments and disabled reason. */
function HomeAction({ action, onAction, menu }: { action: Action; onAction: HomeViewProps["onAction"]; menu?: boolean }) {
  return <span className="home-action"><button role={menu ? "menuitem" : undefined} type="button" data-flow={action.tag} disabled={!!action.disabled}
    onClick={() => onAction(action.tag, action.args ?? {})}>{action.label}</button>
    {action.disabled ? <span className="meta">{action.disabled.reason}</span> : null}</span>
}

function HomeFilter({ state, count, view, onView }: { state: TodoState; count: number } & Pick<HomeViewProps, "view" | "onView">) {
  return <button type="button" className="filter" data-filter={state} disabled={count === 0 && view.filter !== state} aria-pressed={view.filter === state}
    onClick={() => onView({ filter: view.filter === state ? undefined : state })}><StateWord state={state} /><b>{count}</b></button>
}

// Captions from the Home mock's MergeReady presentation and ui-components Shared Merge.
const mergeWords = { state: "Not in review yet", order: "Merges after", attention: "Needs you", merging: "Merging", rechecking: "Checks running", pending_work: "Pending work", stale_head: "Rebase pending", checks: "Checks", review_required: "Review required", github: "GitHub" }
const ORDER = new Set(["Move up", "Move down", "Drop"])

function HomeRow({ item, onAction, now, view, onView }: { item: HomeItem; now: number } & Pick<HomeViewProps, "onAction" | "view" | "onView">) {
  const open = view.menu === item.n
  const setOpen = (value: boolean) => onView({ menu: value ? item.n : undefined })
  const trigger = useRef<HTMLButtonElement>(null)
  const menuItems = useRef<HTMLButtonElement[]>([])
  const clockBase = useRef({ at: now, elapsed: item.elapsed_s, state: item.state })
  if (clockBase.current.elapsed !== item.elapsed_s || clockBase.current.state !== item.state) clockBase.current = { at: now, elapsed: item.elapsed_s, state: item.state }
  const elapsed = (item.elapsed_s ?? 0) + (item.state === "working" || item.state === "starting" ? Math.max(0, Math.floor((now - clockBase.current.at) / 1000)) : 0)
  const title = item.actions.find(action => action.args?.door === "title")
  const branch = item.actions.find(action => action.tag === "branch" && action.args?.door === "branch")
    ?? item.actions.find(action => action.tag === "branch" && action.label !== "Resolve")
  const menu = item.actions.filter(action => action !== title && action !== branch && ORDER.has(action.label))
  const actions = item.actions.filter(action => action !== title && action !== branch && !ORDER.has(action.label))
  const actionControls = []
  for (const [index, action] of actions.entries()) actionControls.push(<HomeAction key={index} action={action} onAction={onAction} />)
  const menuControls = []
  for (const [index, action] of menu.entries()) menuControls.push(<HomeAction key={index} action={action} onAction={(tag, args) => { setOpen(false); trigger.current?.focus(); onAction(tag, args) }} menu />)
  return <li className="stack-row" data-state={item.state}>
    <span className="stack-node">{item.place}</span>
    <div className="stack-main"><div className="stack-title"><span className="ref">T{item.n}</span>{title ? <><button type="button" className="link" data-flow={title.tag} disabled={!!title.disabled} onClick={() => onAction(title.tag, title.args ?? {})}>{item.title}</button>{title.disabled ? <span className="meta">{title.disabled.reason}</span> : null}</> : <span>{item.title}</span>}{item.amendments > 0 ? <span className="count-chip">+{item.amendments}</span> : null}</div>
      <div className="meta"><StateWord state={item.state} step={item.step} />
        <span className="where">{branch ? <button type="button" className="branch-chip" data-flow={branch.tag} disabled={!!branch.disabled}
          onClick={() => onAction(branch.tag, branch.args ?? {})}>{item.branch.name}</button> : item.branch.name}{branch?.disabled ? <span>{branch.disabled.reason}</span> : null}{item.present.map((actor, index) => <ActorChip key={index} actor={actor} size="s" live={item.state === "working"} />)}</span>
        {item.pr ? <span>#{item.pr.number}{item.pr.draft ? " · Draft" : ""}</span> : null}
        {item.needs_you ? <span className="warn-text">{item.needs_you.prompt}</span> : null}
        {item.queue ? <span> {item.queue.reason === "machine" ? `waiting for a machine #${item.queue.position}` : item.queue.reason === "daily_limit" ? "Daily limit reached · starts tomorrow" : item.queue.reason === "rebase" ? "rebase pending" : item.queue.after === undefined ? "merges after" : `merges after T${item.queue.after}`}</span> : null}
        {item.rebase_pending ? <span className="warn-text">Rebase pending onto {item.rebase_pending.onto}</span> : null}
        {item.state === "in_review" && item.merge.state !== "ready" && item.merge.reason ? <span>{mergeWords[item.merge.reason]}{item.merge.detail ? ` ${item.merge.detail}` : ""}</span> : null}
        {item.approval_cleared ? <span className="warn-text">approval cleared by rebase</span> : null}
        <LessonsCount count={item.lessons} />
        {item.elapsed_s !== undefined ? <span className="elapsed">{Math.floor(elapsed)} s</span> : null}
      </div></div>
    <span className="row-end" onKeyDown={event => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus() } }}>{actionControls}
      {menu.length ? <button type="button" ref={trigger} className="icon-btn" aria-haspopup="menu" aria-label={`Order ${item.title}`} aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={16} /></button> : null}
      {open ? <span className="menu" role="menu" aria-label={`Order ${item.title}`} ref={element => {
        if (!element) return
        menuItems.current = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const dismiss = (event: PointerEvent) => {
          let target = event.target as Node | null
          while (target && target !== element.parentElement) target = target.parentNode
          if (!target) setOpen(false)
        }
        document.addEventListener("pointerdown", dismiss)
        return () => document.removeEventListener("pointerdown", dismiss)
      }} onKeyDown={event => {
        let index = -1
        for (let i = 0; i < menuItems.current.length; i++) if (menuItems.current[i] === document.activeElement) index = i
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
          event.preventDefault()
          const next = event.key === "Home" ? 0 : event.key === "End" ? menuItems.current.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + menuItems.current.length) % menuItems.current.length
          menuItems.current[next]?.focus()
        }
      }} onBlur={event => {
        let target = event.relatedTarget as Node | null
        while (target && target !== event.currentTarget.parentElement) target = target.parentNode
        if (!target) setOpen(false)
      }}>{menuControls}</span> : null}
    </span>
  </li>
}

export function HomeView({ model, actions, view, onAction, onView }: HomeViewProps) {
  const now = useClock(true, 1000)
  /* The observer reads the latest callback and view through refs, so a new `onView` identity never re-attaches it. */
  const latest = useRef({ onView, onScreen: view.on_screen })
  latest.current = { onView, onScreen: view.on_screen }
  const observe = useCallback((element: HTMLElement | null) => {
    if (!element || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(entries => {
      const entry = entries.at(-1)
      // Report only a change: an unchanged visibility never patches the view.
      if (entry === undefined || entry.isIntersecting === latest.current.onScreen) return
      latest.current.onScreen = entry.isIntersecting
      latest.current.onView({ on_screen: entry.isIntersecting })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const age = Math.max(0, Math.floor((now - Date.parse(model.main.last_success_at)) / 1000))
  const synced = Date.parse(model.main.last_success_at) <= 0 ? "" : age < 60 ? `synced ${age} s ago` : `synced ${Math.round(age / 60)} min ago`
  const syncActions = actions.filter(action => action.label === "Retry" || action.label === "Fix")
  const otherActions = actions.filter(action => action.label !== "Retry" && action.label !== "Fix")
  const filters = []
  for (const state of ["needs_you", "working", "queued", "in_review"] as const) filters.push(<HomeFilter key={state} state={state} count={model.counts[state] + (state === "working" ? model.counts.starting : 0)} view={view} onView={onView} />)
  const attention = []
  for (const [index, row] of model.attention.entries()) {
    const controls = []
    for (const [index, action] of row.actions.entries()) controls.push(<HomeAction key={index} action={action} onAction={onAction} />)
    attention.push(<div key={index} className="home-attention"><span>{row.text}</span>{controls}</div>)
  }
  const syncControls = [], otherControls = [], rows = [], runs = []
  for (const [index, action] of syncActions.entries()) syncControls.push(<HomeAction key={index} action={action} onAction={onAction} />)
  for (const [index, action] of otherActions.entries()) otherControls.push(<HomeAction key={index} action={action} onAction={onAction} />)
  for (const item of model.items) if (!view.filter || item.state === view.filter || (view.filter === "working" && item.state === "starting")) rows.push(<HomeRow key={item.n} item={item} now={now} onAction={onAction} view={view} onView={onView} />)
  for (const run of model.background_runs) {
    const controls = []
    for (const [index, action] of run.actions.entries()) controls.push(<HomeAction key={index} action={action} onAction={onAction} />)
    runs.push(<li key={run.id} className="run-row" data-state={run.state}><span>{run.title}</span><span className="meta">{run.detail ?? (run.state === "queued" ? "Queued" : run.state === "running" ? "Running" : run.state === "waiting" ? "Waiting" : "Failed")}</span><span className="row-end">{controls}</span></li>)
  }
  return <section ref={observe} className="home smithers-card" data-keyboard-pane="Stack" aria-label={model.repository}>
    <h2>{model.repository}</h2>
    {attention}
    <div className="filters">{filters}</div>
    <ol className="stack" aria-label="Stack"><li className="stack-main-row"><span className="stack-node"><GitBranch size={14} /></span>
      <span className="stack-trunk">main <span title={model.main.sha}>{model.main.title}</span>{model.merged_since_last_look.length ? <span className="merged-since">{model.merged_since_last_look.length} merged since you looked</span> : null}</span>
      <span className="sync" data-stale={model.main.health !== "fresh" || undefined} data-health={model.main.health}>
        {model.main.health === "fresh" ? synced : model.main.health === "stale" ? `${synced}${model.main.cause ? ` · ${model.main.cause}` : ""}` : model.main.cause}
        {model.main.retry_at ? ` · retries at ${model.main.retry_at}` : null}{syncControls}</span></li>
      {rows}</ol>
    {runs.length ? <ul className="runs" aria-label="Background runs">{runs}</ul> : null}
    <div className="actions"><div className="machines" aria-label={`${model.machines.in_use} of ${model.machines.capacity} machines in use`}>{model.machines.slots.map((slot, index) => <span key={index} className="machine" data-used title={`${slot.branch} · ${actorName(slot.actor)}`}><ActorChip actor={slot.actor} size="s" live={slot.awake} /></span>)}{Array.from({ length: Math.max(0, model.machines.capacity - model.machines.slots.length) }, (_, index) => <span className="machine" key={`free-${index}`} title="Free" />)}<span className="machines-label">{model.machines.in_use}/{model.machines.capacity} machines</span></div><span className="actions-end">{otherControls}</span></div>
  </section>
}
