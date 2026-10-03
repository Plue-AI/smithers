/*
 * One member's screen, built from the app's own shell anatomy (App.tsx,
 * SessionNavigation.tsx): the wordmark row, the transcript of chat bubbles and
 * cards, the floating composer, the Chat control and the toast stack.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { ChatComposer, ChatMessage } from "@smthrs/ui"
import { ChevronDown } from "lucide-react"
import { Notifications, Rail, markOf, noticesOf, type Mark } from "./Rail"
import { FrameContext, typedOr, type FrameValue } from "./frame"
import { BranchCard } from "./cards/Branch"
import { DiffCard, FileCard } from "./cards/Code"
import { HomeCard } from "./cards/Home"
import { TerminalCard } from "./cards/Terminal"
import { TodoCard } from "./cards/Todo"
import { EXTRA_CARDS } from "./cards/extra"
import { Avatar, ContextChip, Maximized, actorName } from "./parts"
import { BranchTree } from "./Tree"
import { WORDMARK } from "../../../../apps/app/src/mainview/Wordmark"
import { STACK, type CardKind, type CardRef, type Event, type State } from "./world"

export interface Pointer {
  readonly x: number
  readonly y: number
  readonly pressing: boolean
}

const CardView = ({ card }: { readonly card: CardRef }) => {
  switch (card.kind) {
    case "home": return <HomeCard id={card.id} {...(card.view === undefined ? {} : { view: card.view })} />
    case "todo": return <TodoCard id={card.id} target={card.target} />
    case "branch": return <BranchCard id={card.id} target={card.target} {...(card.view === undefined ? {} : { view: card.view })} />
    case "terminal": return <TerminalCard id={card.id} target={card.target} />
    case "file": return <FileCard id={card.id} target={card.target} {...(card.view === undefined ? {} : { view: card.view })} />
    case "diff": return <DiffCard id={card.id} target={card.target} {...(card.view === undefined ? {} : { view: card.view })} />
    default: {
      const Extra = EXTRA_CARDS[card.kind]
      return Extra === undefined ? null : <Extra id={card.id} target={card.target} {...(card.view === undefined ? {} : { view: card.view })} />
    }
  }
}

/*
 * Where this person is in the branch tree: main, then the branch, each a door up the tree. The last crumb opens
 * the whole tree (mvp.md B.1), which also reaches the branch's own forks.
 */
const Crumbs = ({ world, at, tree }: { readonly world: State["world"]; readonly at: string; readonly tree: boolean }) => {
  const branch = world.branches.find(each => each.id === at)
  const host = branch === undefined ? undefined : world.branches.find(each => each.id === branch.from)
  return (
    <div className="mvp-crumbs">
      <nav className="mvp-crumb-path" aria-label="Branch">
        <span className="mvp-crumb-repo">{world.repo}</span>
        <span aria-hidden="true">/</span>
        {branch === undefined ? null : <><button type="button" className="mvp-crumb" data-mock="crumb-main">main</button><span aria-hidden="true">/</span></>}
        {host === undefined ? null : <><button type="button" className="mvp-crumb" data-mock={`crumb-${host.id}`}>{host.name}</button><span aria-hidden="true">/</span></>}
        <button type="button" className="mvp-crumb mvp-crumb-here" aria-haspopup="true" aria-expanded={tree} data-mock="crumb-tree">
          {branch?.name ?? "main"}<ChevronDown size={13} aria-hidden="true" /></button>
      </nav>
      {tree ? <BranchTree world={world} at={at} /> : null}
    </div>
  )
}

export const AppFrame = ({ frame, pointer, keys }: {
  readonly frame: FrameValue
  readonly pointer: Pointer | undefined
  /** A chord being pressed on this screen, shown as key caps. */
  readonly keys: string | undefined
}) => {
  const screen = frame.state.viewers[frame.me]!
  const scroller = useRef<HTMLDivElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  const count = screen.transcript.length
  const marks = screen.transcript.flatMap(entry => { const mark = markOf(frame.state, frame.me, entry); return mark === undefined ? [] : [mark] }) as ReadonlyArray<Mark>
  const [inView, setInView] = useState<readonly [number, number]>([0, Number.MAX_SAFE_INTEGER])
  const [desktop, setDesktop] = useState(true)
  /* Which timeline entries are on screen: the rail's band, and what counts as above or below. */
  const measure = () => {
    const node = scroller.current
    if (node === null) return
    const box = node.getBoundingClientRect()
    let first = -1
    let last = -1
    marks.forEach((mark, index) => {
      const element = node.querySelector(`[data-entry="${mark.id}"]`)
      if (element === null || mark.event === true) return
      const rect = element.getBoundingClientRect()
      if (rect.bottom > box.top + 24 && rect.top < box.bottom - 24) {
        if (first < 0) first = index
        last = index
      }
    })
    const next: readonly [number, number] = first < 0 ? [marks.length, marks.length - 1] : [first, last]
    if (next[0] !== inView[0] || next[1] !== inView[1]) setInView(next)
    const wide = (shell.current?.clientWidth ?? 0) >= 1180
    if (wide !== desktop) setDesktop(wide)
  }
  useLayoutEffect(measure)
  /** This person's view of a card: their own tab or open menu, never another person's. */
  const viewOf = (card: CardRef): CardRef => {
    const own = screen.views[card.id]
    return own === undefined ? card : { ...card, view: own }
  }
  const jump = (id: string) => scroller.current?.querySelector(`[data-entry="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })
  /*
   * A shared conversation keeps each person's place: a new entry pulls this
   * screen to the bottom only if it was already there, as a chat does. A card
   * this person reopens scrolls their screen to it, and no one else's.
   */
  const atBottom = useRef(true)
  /* The first layout jumps straight to its place (a scrubbed or still frame); later steps scroll smoothly. */
  const first = useRef(true)
  useLayoutEffect(() => {
    const node = scroller.current
    if (node !== null && atBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: first.current ? "auto" : "smooth" })
  }, [count, frame.state.seq, screen.at])
  useLayoutEffect(() => {
    if (screen.reveal !== undefined) {
      const target = () => scroller.current?.querySelector(`[data-entry="${screen.reveal!.id}"]`)
      if (first.current) {
        /* Cards above may still grow while they lay out, so a still frame settles on its card a few times. */
        for (const delay of [0, 120, 360]) setTimeout(() => target()?.scrollIntoView({ block: "nearest", behavior: "auto" }), delay)
      } else target()?.scrollIntoView({ block: "nearest", behavior: "smooth" })
      /* Looking at a card is a place: new entries below no longer pull this screen down. */
      atBottom.current = screen.transcript.at(-1)?.id === screen.reveal.id
    }
    first.current = false
  }, [screen.reveal?.seq])
  const events = screen.transcript.filter((entry): entry is Event => entry.kind === "event")
  const notices = noticesOf(frame.state, events, screen.notifyAsk === "open")
  const spotlight = screen.focus !== undefined
  return (
    <FrameContext.Provider value={frame}>
      <div className="session-shell mock-shell" data-frame={frame.me} data-spotlight={spotlight || undefined} data-desktop={desktop || undefined} ref={shell}
        data-theme={screen.theme}>
        <header className="session-navigation" aria-label="Smithers">
          <h1 className="guide-wordmark" aria-label="Smithers" style={{ margin: 0 }}>
            <pre aria-hidden="true">{WORDMARK.map((line, index) => <span key={index} style={{ "--row": index } as CSSProperties}>{line}{"\n"}</span>)}</pre>
          </h1>
          <Crumbs world={frame.state.world} at={screen.at} tree={screen.tree === true} />
        </header>
        <div className="app-shell">
          <div className="app-main">
            <div className="tab-body" data-kind="main">
              <div className="chat-frame">
                <div className="chat-column">
                  <div className="sui-chat-transcript smithers-transcript" role="log" aria-label="Conversation">
                    <div className="sui-msg-scroller mock-scroller" ref={scroller} onScroll={event => {
                      const node = event.currentTarget
                      atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
                      measure()
                    }}>
                      <div className="sui-chat-messages mock-messages">
                        {screen.transcript.filter(entry => entry.kind !== "event").map(entry =>
                          entry.kind === "card" ? (entry.card.as === undefined
                            ? <div key={entry.id} className="mock-entry" data-entry={entry.id}><CardView card={viewOf(entry.card)} /></div>
                            : <div key={entry.id} className="mock-entry mock-as" data-entry={entry.id} data-as={`as ${frame.state.world.members.find(each => each.id === entry.card.as)?.name.split(" ")[0]} sees it`}>
                                <FrameContext.Provider value={{ ...frame, me: entry.card.as }}><CardView card={entry.card} /></FrameContext.Provider></div>)
                          : <div key={entry.id} className="mock-message" data-entry={entry.id} data-mine={(entry.kind === "user" ? entry.by : entry.for) === frame.me || undefined}
                              data-mock={entry.kind === "agent" && entry.by !== undefined ? `imported-${entry.by}` : undefined}>
                              {/* A shared conversation names who asked, and who Smithers answered for, on every screen (M-34; Astra r2 M1). Your own prompts need no name. */}
                              {entry.kind === "user" && entry.by !== undefined && (entry.by !== frame.me || entry.origin !== undefined)
                                ? <span className="mvp-author"><Avatar world={frame.state.world} who={entry.by} size={16} />{actorName(frame.state.world, entry.by)}
                                    {entry.origin === undefined ? null : <span className="mvp-origin">{entry.origin}</span>}</span> : null}
                              {entry.kind === "agent"
                                ? <span className="mvp-author"><Avatar world={frame.state.world} who={entry.by ?? (entry.for === undefined ? STACK : `${entry.for}~smithers`)} size={16} />
                                    {actorName(frame.state.world, entry.by ?? (entry.for === undefined ? STACK : `${entry.for}~smithers`))}
                                    {entry.origin === undefined ? null : <span className="mvp-origin">{entry.origin}</span>}</span> : null}
                              <ChatMessage role={entry.kind === "user" ? "user" : "assistant"} className="smithers-chat-message">{entry.text}</ChatMessage>
                              {entry.kind === "agent" && entry.context !== undefined ? (
                                <ContextChip id={entry.id} items={entry.context} open={screen.views[`context:${entry.id}`] === "open"} />
                              ) : null}
                            </div>)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {screen.composerOpen ? (
            <div className="composer-overlay" data-testid="composer-overlay">
              <div className="composer-wrap">
                <ChatComposer className="smithers-composer" value={typedOr(frame, "composer", screen.draft)} onValueChange={() => {}}
                  onSubmit={() => {}} placeholder="Ask Smithers to work on something…" lifecycleStatus="ready"
                  actions={<button type="button" className="composer-queue-action" disabled>Queue</button>} />
              </div>
            </div>
          ) : null}
          <footer className="app-chat-controls" aria-label="Chat controls">
            <button type="button" className="guide-button" data-mock="chat-open">
              <span className="guide-button-content">Chat</span> <kbd className="guide-button-key" aria-hidden="true">⌘ K</kbd>
            </button>
          </footer>
        </div>
        <aside className="mvp-rail" aria-label="Activity rail">
          <Rail marks={marks} inView={inView} desktop={desktop} onJump={jump} noticed={new Set(desktop ? notices.map(each => each.id) : [])}>
            {desktop ? <Notifications state={frame.state} events={events} ask={screen.notifyAsk === "open"} docked /> : null}
          </Rail>
        </aside>
        {desktop ? null : <Notifications state={frame.state} events={events} ask={screen.notifyAsk === "open"} />}
        {spotlight ? <div className="mock-spotlight-dim" aria-hidden="true" /> : null}
        {screen.connection === "reconnecting" ? <div className="mvp-reconnecting" role="status"><span className="mvp-spin" aria-hidden="true" />Reconnecting to maya-mini</div> : null}
        {(() => {
          if (screen.maximized === undefined) return null
          const entry = screen.transcript.find(each => each.kind === "card" && each.card.id === screen.maximized)
          /* A card can open maximized without an entry of its own: Inspect on a TODO opens its run's monitor. */
          const [kind = "", ...rest] = screen.maximized.split(":")
          const card: CardRef = entry?.kind === "card" ? entry.card : { id: screen.maximized, kind: kind as CardKind, target: rest.join(":") }
          return (
            <>
              <div className="card-maximize-backdrop mock-max-backdrop" aria-hidden="true" />
              <div className="mock-max"><Maximized.Provider value={true}><CardView card={{ ...viewOf(card), view: "max" }} /></Maximized.Provider></div>
            </>
          )
        })()}
        {screen.outside?.bare ? <div className="mock-desktop" aria-hidden="true" /> : null}
        {screen.outside === undefined ? null : (
          <div className="mock-outside" data-bare={screen.outside.bare || undefined} aria-label={screen.outside.title}>
            <div className="mock-outside-bar"><i /><i /><i /><span>{screen.outside.title}</span></div>
            <pre>{screen.outside.lines.join("\n")}{typedOr(frame, "outside", "")}<span className="mvp-term-cursor" aria-hidden="true" /></pre>
          </div>
        )}
        {keys === undefined ? null : <div className="mock-keys" aria-hidden="true">{keys.split(" ").map(key => <kbd key={key}>{key}</kbd>)}</div>}
        {pointer === undefined ? null : (
          <div className="mock-pointer" data-pressing={pointer.pressing || undefined} style={{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }} aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.4 1.5L8.4 18z" fill="#211d18" stroke="#fffefa" strokeWidth="1.4" strokeLinejoin="round" /></svg>
          </div>
        )}
      </div>
    </FrameContext.Provider>
  )
}
