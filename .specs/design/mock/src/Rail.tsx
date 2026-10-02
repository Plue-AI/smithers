/*
 * The timeline (Will, 2026-10-02). There are no toast notifications: what a
 * toast would say is a timeline entry. One line per conversation entry and
 * per event, with a cheap model's summary of what happened there. A band marks
 * what is on screen. Live work above the band pins to the top edge and live
 * work below it, plus anything new, pins to the bottom edge, so the edges say
 * what the conversation is doing off screen. An entry that needs a person
 * carries its one action inline. Desktop only; a narrow screen keeps one pill
 * per edge.
 */
import type { ReactNode } from "react"
import { Button, Spinner } from "@smthrs/ui"
import { Bell, Check, CircleAlert, MessageSquare, X } from "lucide-react"
import { StateGlyph, actorName } from "./parts"
import { isAgent, refOf, type Entry, type Event, type State } from "./world"

export type Tone = "live" | "attention" | "failed" | "done" | "quiet"

export interface Mark {
  readonly id: string
  readonly title: string
  /** One line on what happened there: in the product, a cheap model writes it from the run's events. */
  readonly summary: string
  readonly tone: Tone
  /** The one act it offers while it applies (Answer, Retry, Review & merge). */
  readonly action?: string
  readonly secondary?: string
  readonly glyph: ReactNode
  /** An event that just arrived: it highlights once. */
  readonly fresh?: boolean
  /** Events are not cards: they live only in the timeline. */
  readonly event?: boolean
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const EVENT_TONE: Record<Event["tone"], Tone> = { running: "live", ok: "done", attention: "attention", failed: "failed" }

const eventGlyph = (tone: Event["tone"]): ReactNode =>
  tone === "running" ? <Spinner size="sm" aria-label="Working" />
  : tone === "ok" ? <Check size={13} className="mvp-tl-ok" aria-hidden="true" />
  : tone === "attention" ? <CircleAlert size={13} className="mvp-toast-attention" aria-hidden="true" />
  : <X size={13} className="mvp-tl-failed" aria-hidden="true" />

/** The timeline's line for one transcript entry. */
export const markOf = (state: State, me: string, entry: Entry): Mark | undefined => {
  const { world } = state
  if (entry.kind === "event") {
    return {
      id: entry.id, title: entry.title, summary: entry.detail ?? "", event: true, fresh: entry.seq === state.seq && entry.acked !== true,
      tone: entry.acked === true && entry.tone !== "running" ? "quiet" : EVENT_TONE[entry.tone], glyph: eventGlyph(entry.tone),
      ...(entry.acked === true || entry.action === undefined ? {} : { action: entry.action }),
      ...(entry.acked === true || entry.secondary === undefined ? {} : { secondary: entry.secondary })
    }
  }
  if (entry.kind === "user") return { id: entry.id, title: `“${entry.text}”`, summary: "", tone: "quiet", glyph: <MessageSquare size={12} aria-hidden="true" /> }
  if (entry.kind === "agent") return undefined
  const { card } = entry
  switch (card.kind) {
    case "home": {
      const items = world.stack.map(id => world.todos.find(todo => todo.id === id)).filter(each => each !== undefined)
      const needs = items.filter(todo => todo.state === "needs-you").length
      const working = items.filter(todo => todo.state === "working" || todo.state === "starting").length
      return { id: entry.id, title: world.repo, summary: [needs > 0 ? `${needs} need you` : "", working > 0 ? `${working} working` : ""].filter(Boolean).join(" · "),
        tone: needs > 0 ? "attention" : working > 0 ? "live" : "quiet", glyph: <StateGlyph state={needs > 0 ? "needs-you" : "working"} /> }
    }
    case "todo": {
      const todo = world.todos.find(each => each.id === card.target)
      if (todo === undefined) return undefined
      const branch = world.branches.find(each => each.id === todo.branch)
      const last = branch?.activity.at(-1)
      const summary = todo.state === "needs-you" ? `Asks: ${todo.question?.text ?? "a question"}`
        : todo.state === "in-review" ? `PR #${todo.pr} ready for review`
        : todo.state === "merged" ? `Merged${todo.lessons === undefined ? "" : ` · ${plural(todo.lessons, "lesson")}`}`
        : todo.state === "failed" ? `Failed: ${todo.failure ?? ""}`
        : todo.state === "queued" ? "Waiting for a machine"
        : last === undefined ? `At ${world.flow.find(step => step.id === todo.step)?.title ?? "work"}` : `${actorName(world, last.who)}: ${last.text}`
      const tone: Tone = todo.state === "needs-you" ? "attention" : todo.state === "failed" ? "failed" : todo.state === "working" ? "live" : todo.state === "merged" ? "done" : "quiet"
      return { id: entry.id, title: `${refOf(world, todo)} ${todo.title}`, summary, tone, glyph: <StateGlyph state={todo.state} /> }
    }
    case "branch": {
      const branch = world.branches.find(each => each.id === card.target)
      if (branch === undefined) return undefined
      const people = branch.presence.filter(each => !isAgent(each.who)).length
      const last = branch.activity.at(-1)
      return { id: entry.id, title: branch.name, summary: last === undefined ? (people === 0 ? "" : `${plural(people, "person")} here`) : `${actorName(world, last.who)}: ${last.kind === "change" ? `changed ${last.files} files` : last.text}`,
        tone: branch.machine === "awake" && branch.presence.some(each => each.who.startsWith("agent")) ? "live" : "quiet", glyph: <StateGlyph state={branch.machine === "awake" ? "working" : "queued"} /> }
    }
    case "terminal": {
      const session = world.terminals.find(each => each.id === card.target)
      if (session === undefined) return undefined
      const last = [...session.lines].reverse().find(line => line.tone === "ok" || line.tone === "fail")
      return { id: entry.id, title: session.title, summary: session.running !== undefined ? `Running ${session.running}` : last === undefined ? "Ready" : last.text.trim(),
        tone: session.running !== undefined ? "live" : last?.tone === "fail" ? "failed" : "quiet", glyph: <StateGlyph state={session.running !== undefined ? "working" : last?.tone === "fail" ? "failed" : "queued"} /> }
    }
    case "file": {
      const doc = world.files.find(each => each.path === card.target)
      if (doc === undefined) return undefined
      const editors = (doc.editors ?? []).filter(each => each.who !== me).map(each => actorName(world, each.who))
      const cited = /^lines:(\d+)-(\d+)$/.exec(card.view ?? "")
      const onMachine = world.branches.some(each => each.id === doc.branch && each.machine !== "closed")
      return { id: entry.id, title: doc.path.split("/").at(-1) ?? doc.path,
        summary: cited !== null ? `Lines ${cited[1]}–${cited[2]} cited` : editors.length > 0 ? `${editors.join(" and ")} editing` : onMachine ? "Saved to the machine" : "",
        tone: editors.length > 0 ? "live" : "quiet", glyph: <StateGlyph state={editors.length > 0 ? "working" : "queued"} /> }
    }
    case "review": {
      const review = world.reviews.find(each => each.id === card.target)
      return { id: entry.id, title: "Review", summary: review === undefined ? "" : review.verdict === "clean" ? "No findings" : plural(review.findings.length, "finding"), tone: "quiet", glyph: <StateGlyph state="in-review" /> }
    }
    case "issue": {
      const issue = world.issues.find(each => String(each.number) === card.target)
      return { id: entry.id, title: issue === undefined ? "Issue" : `#${issue.number} ${issue.title}`, summary: issue === undefined ? "" : issue.open ? plural(issue.comments.length + 1, "comment") : "Closed",
        tone: "quiet", glyph: <StateGlyph state="queued" /> }
    }
    case "draft": {
      const draft = world.drafts.find(each => each.id === card.target)
      return { id: entry.id, title: draft?.title ?? "New TODO", summary: draft?.committed === undefined ? "Draft" : "Committed", tone: "quiet", glyph: <StateGlyph state="queued" /> }
    }
    case "confirm": {
      const todo = world.todos.find(each => each.id === card.target)
      return { id: entry.id, title: todo === undefined ? "Merge" : `Merge ${refOf(world, todo)}`, summary: todo?.state === "merged" ? "Merged" : "Waiting for you", tone: todo?.state === "merged" ? "done" : "attention",
        glyph: <StateGlyph state={todo?.state === "merged" ? "merged" : "in-review"} /> }
    }
    case "diff": return { id: entry.id, title: `Diff · ${card.target.split("/").at(-1)}`, summary: "", tone: "quiet", glyph: <StateGlyph state="queued" /> }
    case "flow": {
      const states = new Set(world.flowVersions.map(each => each.state))
      const summary = states.has("merged-failed") ? "Merged · not active" : states.has("merged-syncing") ? "Merged · active after sync" : states.has("proposed") ? "Change proposed" : "Active"
      return { id: entry.id, title: card.target === "todo" ? "TODO flow" : `${card.target} flow`, summary, tone: states.has("merged-failed") ? "failed" : "quiet", glyph: <StateGlyph state="queued" /> }
    }
    case "proposal": {
      const proposal = world.proposals.find(each => each.id === card.target)
      return { id: entry.id, title: proposal?.title ?? "Suggestion", summary: "Suggested by learning", tone: "quiet", glyph: <StateGlyph state="queued" /> }
    }
    case "wiki": {
      const page = world.wiki.find(each => each.id === card.target)
      const editing = (page?.editors ?? []).filter(each => each.who !== me).map(each => actorName(world, each.who))
      return { id: entry.id, title: page?.title ?? "Wiki", summary: editing.length > 0 ? `${editing.join(" and ")} editing` : page === undefined ? "" : `r${page.rev}`,
        tone: editing.length > 0 ? "live" : "quiet", glyph: <StateGlyph state={editing.length > 0 ? "working" : "queued"} /> }
    }
    case "act": {
      const act = world.acts.find(each => each.id === card.target)
      if (act === undefined) return undefined
      const asked = act.state === "asked"
      return { id: entry.id, title: `${act.verb} ${act.target}`, summary: asked ? (act.by === me ? "Waiting for you" : `Waiting for ${actorName(world, act.by)}`) : act.state === "done" ? act.receipt : "Cancelled",
        tone: asked && act.by === me ? "attention" : "quiet", glyph: <StateGlyph state={asked ? "needs-you" : "merged"} /> }
    }
    case "run": {
      const trace = world.traces.find(each => each.id === card.target)
      if (trace === undefined) return undefined
      const word = trace.state === "running" ? "Working" : trace.state === "waiting" ? "Waiting for a person" : trace.state === "held" ? "Waiting for merge" : trace.state === "merged" ? "Merged" : "Failed"
      return { id: entry.id, title: trace.title, summary: word, tone: trace.state === "waiting" ? "attention" : trace.state === "running" ? "live" : trace.state === "failed" ? "failed" : "quiet",
        glyph: <StateGlyph state={trace.state === "waiting" ? "needs-you" : trace.state === "running" ? "working" : trace.state === "failed" ? "failed" : trace.state === "merged" ? "merged" : "in-review"} /> }
    }
    default: {
      const titles: Partial<Record<typeof card.kind, string>> = { commands: "Commands", setup: "Set up Smithers", settings: "Settings", members: "Members", secrets: "Secrets", later: "Not in this release" }
      return { id: entry.id, title: titles[card.kind] ?? card.kind[0]!.toUpperCase() + card.kind.slice(1), summary: "", tone: "quiet", glyph: <StateGlyph state="queued" /> }
    }
  }
}

const LIVE: ReadonlySet<Tone> = new Set(["live", "attention", "failed"])

/*
 * Notifications (Will, 2026-10-02): notable events, and anything that needs
 * the person (an approval, Needs you), also pop as notifications at the
 * bottom-left, where the timeline's new entries arrive. One with an action
 * stays until someone acts or hides it; hiding keeps its timeline entry and
 * its action. A notable event without an action shows once, then settles into
 * the timeline.
 */
/* The one-time ask, at a person's first Needs you: browser notifications while the tab is hidden (mvp.md §6.4). */
const NotifyAsk = () => (
  <div className="mvp-notice" data-tone="attention" role="status">
    <span className="mvp-notice-icon"><Bell size={13} aria-hidden="true" /></span>
    <span className="mvp-notice-body">
      <b>Notify me when Smithers needs you</b>
      <span className="mvp-notice-actions"><Button size="sm" variant="outline" data-mock="notify-allow">Allow</Button></span>
    </span>
    <button type="button" className="mvp-notice-hide" aria-label="Not now" data-mock="notify-hide"><X size={13} aria-hidden="true" /></button>
  </div>
)

export const Notifications = ({ state, events, ask = false }: { readonly state: State; readonly events: ReadonlyArray<Event>; readonly ask?: boolean }) => {
  const shown = events.filter(event => event.acked !== true && event.hidden !== true && event.tone !== "running"
    && (event.action !== undefined || event.seq === state.seq)).slice(ask ? -2 : -3)
  if (shown.length === 0 && !ask) return null
  return (
    <div className="mvp-notify" aria-label="Notifications">
      {shown.map(event => (
        <div key={event.id} className="mvp-notice" data-tone={event.tone} data-fresh={event.seq === state.seq || undefined} role={event.tone === "failed" ? "alert" : "status"}>
          <span className="mvp-notice-icon">{eventGlyph(event.tone)}</span>
          <span className="mvp-notice-body">
            <b>{event.title}</b>
            {event.detail === undefined ? null : <span>{event.detail}</span>}
            {event.action === undefined ? null : (
              <span className="mvp-notice-actions">
                <Button size="sm" variant="outline" data-mock={`toast-${event.action.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{event.action}</Button>
              </span>
            )}
          </span>
          <button type="button" className="mvp-notice-hide" aria-label={`Hide ${event.title}`} data-mock="toast-hide"><X size={13} aria-hidden="true" /></button>
        </div>
      ))}
      {ask ? <NotifyAsk /> : null}
    </div>
  )
}

/** Pinned rows per edge of the timeline. */
const PINNED = 2

export const Rail = ({ marks, inView, desktop, onJump }: {
  readonly marks: ReadonlyArray<Mark>
  /** Index range of the card marks on screen. */
  readonly inView: readonly [number, number]
  readonly desktop: boolean
  readonly onJump: (id: string) => void
}) => {
  const above = marks.slice(0, inView[0]).filter(mark => LIVE.has(mark.tone) && mark.event !== true)
  const below = marks.slice(inView[1] + 1).filter(mark => LIVE.has(mark.tone) || mark.fresh === true)
  if (!desktop) {
    /* Narrow screens (and phones): the timeline collapses to one pill per edge. */
    const pill = (list: ReadonlyArray<Mark>, direction: "up" | "down") => list.length === 0 ? null : (
      <button type="button" className="mvp-edge-pill" data-direction={direction}
        data-tone={list.some(mark => mark.tone === "attention") ? "attention" : list.some(mark => mark.tone === "failed") ? "failed" : "live"}
        onClick={() => onJump(list[0]!.id)} data-mock={`edge-pill-${direction}`}>
        {direction === "up" ? "↑" : "↓"} {list.length} {direction === "up" ? "live above" : list.some(mark => mark.fresh === true) ? "new below" : "live below"}</button>
    )
    return <>{pill(above, "up")}{pill(below, "down")}</>
  }
  /* Live work off screen pins to the edges as two opaque groups that stack, so pinned rows never draw over each other. */
  /* At most two pinned rows per edge, people-needed first; the rest is one count that jumps to the nearest. */
  const edge = (list: ReadonlyArray<Mark>, direction: "top" | "bottom") => {
    if (list.length === 0) return null
    const urgency = (mark: Mark) => mark.tone === "attention" ? 0 : mark.tone === "failed" ? 1 : 2
    const pinned = new Set([...list].sort((a, b) => urgency(a) - urgency(b)).slice(0, PINNED).map(mark => mark.id))
    const rest = list.filter(mark => !pinned.has(mark.id))
    const nearest = direction === "top" ? rest.at(-1) : rest[0]
    return (
      <ol className="mvp-tl-edge" data-edge={direction}>
        {direction === "bottom" || nearest === undefined ? null : (
          <li><button type="button" className="mvp-tl-more" onClick={() => onJump(nearest.id)} data-mock="pin-more-top">+{rest.length} above</button></li>
        )}
        {list.filter(mark => pinned.has(mark.id)).map(mark => (
          <li key={mark.id} data-tone={mark.tone} data-pinned={direction}>
            <button type="button" className="mvp-tl-row" onClick={() => onJump(mark.id)} data-mock={`pin-${mark.id}`}>
              <span className="mvp-tl-node">{mark.glyph}</span>
              <span className="mvp-tl-text"><b>{mark.title}</b>{mark.summary === "" ? null : <span>{mark.summary}</span>}</span>
            </button>
          </li>
        ))}
        {direction === "top" || nearest === undefined ? null : (
          <li><button type="button" className="mvp-tl-more" onClick={() => onJump(nearest.id)} data-mock="pin-more-bottom">+{rest.length} below</button></li>
        )}
      </ol>
    )
  }
  return (
    <nav className="mvp-timeline" aria-label="Timeline">
      {edge(above, "top")}
      <ol>
        {marks.map((mark, index) => {
          return (
            <li key={mark.id} data-tone={mark.tone} data-event={mark.event || undefined} data-fresh={mark.fresh || undefined}
              data-in-view={index >= inView[0] && index <= inView[1] && mark.event !== true || undefined}>
              <button type="button" className="mvp-tl-row" onClick={() => onJump(mark.id)} data-mock={`tl-${mark.id}`}>
                <span className="mvp-tl-node">{mark.glyph}</span>
                <span className="mvp-tl-text"><b>{mark.title}</b>{mark.summary === "" ? null : <span>{mark.summary}</span>}</span>
              </button>
              {mark.action === undefined && mark.secondary === undefined ? null : (
                <span className="mvp-tl-actions">
                  {mark.action === undefined ? null : <Button size="sm" variant="outline" data-mock={`tl-${mark.action.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{mark.action}</Button>}
                  {mark.secondary === undefined ? null : <Button size="sm" variant="ghost" data-mock="tl-secondary">{mark.secondary}</Button>}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {edge(below, "bottom")}
    </nav>
  )
}
