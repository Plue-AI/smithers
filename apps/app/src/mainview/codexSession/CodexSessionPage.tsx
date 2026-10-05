/*
 * One Codex session in the app's own components: the timeline rail, the
 * conversation's entry rows and the run monitor, all folded at one scrubber
 * position. Scrubbing re-projects the session read-only, the way the monitor's
 * replay does (ui-components.md §11.6.2).
 */
import { useMemo, useRef, useState, type UIEvent } from "react"
import type { RunView as RunViewState } from "@smthrs/rpc/MonitorCard"
import type { BaseView } from "@smthrs/rpc/CardAction"
import type { ShellView } from "@smthrs/rpc/ToastCard"
import { EntryRow } from "../EntryRow"
import { Timeline } from "../Timeline"
import { RunView } from "../cards/views/RunView"
import { projectSession, type CodexSession, type Participants } from "./CodexRollout"

const ignore = () => undefined
const tokensLabel = (count: number): string => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M tokens` : `${Math.round(count / 1000)}k tokens`
const elapsed = (seconds: number): string => seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.round(seconds % 3600 / 60)} min`

export function CodexSessionPage({ session, who }: { readonly session: CodexSession; readonly who?: Participants }) {
  const [pinned, setPinned] = useState<number | undefined>(undefined)  // undefined follows the latest event
  const [view, setView] = useState<BaseView & RunViewState>({ maximized: true, tab: "run" })
  const [band, setBand] = useState<[string, string] | undefined>(undefined)
  const chat = useRef<HTMLElement>(null)
  const model = useMemo(() => projectSession(session, pinned, who), [session, pinned, who])
  const last = model.entries.at(-1)?.id ?? ""
  const on_screen = band ?? [model.entries.at(-2)?.id ?? last, last]

  /* After a render at a new position: the conversation and the rail at their ends, the run at its current cell. */
  const toEnd = () => requestAnimationFrame(() => {
    const node = chat.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
    const rail = node.parentElement?.querySelector(".mvp-timeline")
    if (rail) rail.scrollTop = rail.scrollHeight
    node.parentElement?.querySelector(".mvp-run-timeline [aria-current='true']")?.scrollIntoView({ block: "nearest" })
  })
  const scrub = (at: number) => { setPinned(at >= session.events.length - 1 ? undefined : at); setBand(undefined); setView(current => ({ ...current, selected: undefined })); toEnd() }
  const jump = (patch: ShellView) => {
    if (patch.jump_to === undefined) return
    document.getElementById(`entry-${patch.jump_to}`)?.scrollIntoView({ block: "center", behavior: "smooth" })
    const turn = /^turn-(\d+)$/.exec(patch.jump_to)
    const phase = turn === null ? undefined : model.run.attempts[0]?.phases[Number(turn[1]) - 1]
    if (phase !== undefined) setView(current => ({ ...current, tab: "run", selected: phase.cells.at(-1)?.id }))
  }
  const measure = (event: UIEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const shown = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-entry-id]")]
      .filter(node => { const rect = node.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom })
      .map(node => node.dataset.entryId!)
    if (shown.length > 0) setBand([shown[0]!, shown.at(-1)!])
  }

  const { settings, run } = model
  const facts = [settings.model, settings.effort, settings.tier, settings.sandbox].filter(Boolean).join(" · ")
  return <div className="cx-page">
    <header className="cx-bar">
      <div className="cx-facts">
        <b>Codex</b><span>{facts}</span>
        <span title={session.id}>{session.id.slice(0, 8)}</span>
        <span>{new Date(session.started).toLocaleString()}</span>
        <span>{elapsed(run.time_s)}</span>
        <span>{tokensLabel(run.tokens)}</span>
      </div>
      <label className="cx-scrub">
        <time>{new Date(model.clock).toLocaleTimeString()}</time>
        <input type="range" aria-label="Session position" min={0} max={model.last} value={model.at} onChange={event => scrub(event.currentTarget.valueAsNumber)} />
        <span>{model.at} / {model.last}</span>
        <button type="button" disabled={pinned === undefined} onClick={() => scrub(model.last)}>Latest</button>
      </label>
    </header>
    <div className="cx-body">
      <aside className="mvp-rail" aria-label="Session timeline">
        <Timeline lines={[...model.lines]} on_screen={on_screen} onAction={ignore} onView={jump} />
      </aside>
      <section ref={node => { const first = chat.current === null; chat.current = node; if (node !== null && first) toEnd() }} className="cx-chat" aria-label="Conversation" onScroll={measure}>
        {model.entries.map(entry => <div key={entry.id} id={`entry-${entry.id}`} data-entry-id={entry.id}>
          <EntryRow {...entry} onAction={ignore} />
        </div>)}
      </section>
      <section className="cx-run" aria-label="Run">
        <RunView model={run} actions={[]} gestures={{}} onAction={ignore} view={view}
          onView={patch => { if (patch.at !== undefined) scrub(patch.at); setView(current => ({ ...current, ...patch, at: undefined })) }} />
      </section>
    </div>
  </div>
}
