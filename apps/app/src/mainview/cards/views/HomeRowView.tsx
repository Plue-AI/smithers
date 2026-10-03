import { useRef, useState } from "react"
import { MoreHorizontal } from "lucide-react"
import type { HomeItem, HomeViewProps } from "@smthrs/rpc/HomeCard"
import type { TodoState } from "@smthrs/rpc/CardPrimitives"
import { ActorChip } from "./ActorChip"
import { StateWord } from "./StateWord"
import { HomeActionView } from "./HomeActionView"

export function HomeFilterView({ state, count, view, onView }: { state: TodoState; count: number } & Pick<HomeViewProps, "view" | "onView">) {
  return <button type="button" className="mvp-filter" data-filter={state} disabled={count === 0 && view.filter !== state} aria-pressed={view.filter === state}
    onClick={() => onView({ filter: view.filter === state ? undefined : state })}><StateWord state={state} /><b>{count}</b></button>
}
export function HomeRowView({ item, onAction, now }: { item: HomeItem; now: number } & Pick<HomeViewProps, "onAction">) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuItems = useRef<HTMLButtonElement[]>([])
  const clockBase = useRef({ at: now, elapsed: item.elapsed_s, state: item.state })
  if (clockBase.current.elapsed !== item.elapsed_s || clockBase.current.state !== item.state) clockBase.current = { at: now, elapsed: item.elapsed_s, state: item.state }
  const elapsed = (item.elapsed_s ?? 0) + (item.state === "working" || item.state === "starting" ? Math.max(0, Math.floor((now - clockBase.current.at) / 1000)) : 0)
  // Captions from the Home mock's MergeReady presentation and ui-components Shared Merge.
  const mergeWords = { state: "Not in review yet", order: "Merges after", attention: "Needs you", merging: "Merging", rechecking: "Checks running", pending_work: "Pending work", stale_head: "Rebase pending", checks: "Checks", review_required: "Review required", github: "GitHub" }
  const menu = item.actions.filter(action => action.label === "Move up" || action.label === "Move down" || action.label === "Drop")
  const actions = item.actions.filter(action => action.label !== "Move up" && action.label !== "Move down" && action.label !== "Drop")
  const actionControls = []
  for (const [index, action] of actions.entries()) actionControls.push(<HomeActionView key={index} action={action} onAction={onAction} />)
  const menuControls = []
  for (const [index, action] of menu.entries()) menuControls.push(<HomeActionView key={index} action={action} onAction={onAction} menu />)
  return <li className="mvp-stack-row" data-state={item.state}>
    <span className="mvp-stack-node">{item.place}</span>
    <div className="mvp-stack-main"><div className="mvp-stack-title"><span className="mvp-ref">T{item.n}</span><span>{item.title}</span>{item.amendments > 0 ? <span className="mvp-count-chip">+{item.amendments}</span> : null}</div>
      <div className="mvp-meta"><StateWord state={item.state} step={item.step} />
        <span className="mvp-where">{item.branch.name}{item.present.map((actor, index) => <ActorChip key={index} actor={actor} size="s" live={item.state === "working"} />)}</span>
        {item.pr ? <span>#{item.pr.number}{item.pr.draft ? " · Draft" : ""}</span> : null}
        {item.needs_you ? <span className="mvp-warn-text">{item.needs_you.prompt}</span> : null}
        {item.queue ? <span> {item.queue.reason === "machine" ? `waiting for a machine #${item.queue.position}` : item.queue.reason === "daily_limit" ? "Daily limit reached · starts tomorrow" : item.queue.reason === "rebase" ? "rebase pending" : item.queue.after === undefined ? "merges after" : `merges after T${item.queue.after}`}</span> : null}
        {item.rebase_pending ? <span className="mvp-warn-text">Rebase pending onto {item.rebase_pending.onto}</span> : null}
        {item.state === "in_review" && item.merge.state !== "ready" && item.merge.reason ? <span>{mergeWords[item.merge.reason]}{item.merge.detail ? ` ${item.merge.detail}` : ""}</span> : null}
        {item.approval_cleared ? <span className="mvp-warn-text">approval cleared by rebase</span> : null}
        {item.lessons !== undefined ? <span>{item.lessons} {item.lessons === 1 ? "lesson" : "lessons"}</span> : null}
        {item.elapsed_s !== undefined ? <span className="mvp-elapsed">{Math.floor(elapsed)} s</span> : null}
      </div></div>
    <span className="mvp-row-end" onKeyDown={event => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus() } }}>{actionControls}
      {menu.length ? <button type="button" ref={trigger} className="mvp-icon-btn" aria-haspopup="menu" aria-label={`Order ${item.title}`} aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={16} /></button> : null}
      {open ? <span className="mvp-menu" role="menu" aria-label={`Order ${item.title}`} ref={element => {
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
