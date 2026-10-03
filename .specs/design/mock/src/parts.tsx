/*
 * The design's small vocabulary, shared by every card: who (avatars), where
 * (branch chips), what state (one glyph and one pill per TODO state) and how
 * far (the flow's step strip). Each maps to one CSS block in mock.css.
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react"
import { Button } from "@smthrs/ui"
import { Bot, Check, CircleDashed, FolderSync, GitBranch, GitMerge, GitPullRequest, Layers, Maximize2, Minimize2, Moon, Pause, SquareTerminal, X } from "lucide-react"
import { AGENT, forWhom, isAgent, isSmithers, member, OUTSIDE, refOf, via, type ActorId, type Branch, type FlowStep, type Todo, type TodoState, type World } from "./world"

/* ── Who ─────────────────────────────────────────────────── */

const first = (world: World, who: ActorId): string => member(world, who)?.name.split(" ")[0] ?? who

/**
 * The member an agent acts for (M-34, ui-components Actor `for`): Smithers or
 * an external agent for the person who runs it, a coding agent for its TODO's
 * owner. A person over SSH is that person.
 */
export const actingFor = (world: World, who: ActorId): ActorId | undefined => {
  if (isSmithers(who)) return forWhom(who)
  const acting = via(who)
  if (acting !== undefined) return acting.person
  if (!who.startsWith("agent:")) return undefined
  const item = world.branches.find(each => each.id === who.slice("agent:".length))?.item
  return item === undefined ? undefined : world.todos.find(each => each.id === item)?.owner
}

export const actorName = (world: World, who: ActorId): string => {
  if (who === OUTSIDE) return "Outside Smithers"
  const person = actingFor(world, who)
  const suffix = person === undefined || member(world, person) === undefined ? "" : ` for ${first(world, person)}`
  if (isSmithers(who)) return `Smithers${suffix}`
  const acting = via(who)
  if (acting !== undefined) return who.endsWith("~ssh") ? `${first(world, acting.person)} via SSH` : `${acting.agent}${suffix}`
  return isAgent(who) ? `Coding agent${suffix}` : member(world, who)?.name.split(" ")[0] ?? who
}

/** A line or margin flag's name: "Alice", "Smithers for Ben", "Claude Code for Ben", "Coding agent for Ben", "Maya · SSH". */
export const flagName = (world: World, who: ActorId): string => {
  const acting = via(who)
  if (acting !== undefined && who.endsWith("~ssh")) return `${first(world, acting.person)} · SSH`
  return isAgent(who) || acting !== undefined ? actorName(world, who) : first(world, who)
}

/**
 * The colour a participant's mark, flags and spans use (ui-components Actor
 * color_index): a person's lane, and the same lane for an agent or Smithers
 * acting for them. Undelegated, Smithers is ink and an agent is teal.
 */
export const identityColour = (world: World, who: ActorId): CSSProperties => {
  const lane = member(world, actingFor(world, who) ?? who)?.lane
  return ({ "--who": lane !== undefined ? `var(--lane-${lane})` : isSmithers(who) ? "var(--text)" : isAgent(who) ? "var(--brand)" : "var(--lane-0)" }) as CSSProperties
}

export const Avatar = ({ world, who, size = 22, live = false }: {
  readonly world: World
  readonly who: ActorId
  readonly size?: number
  /** A working agent breathes; a person never does. */
  readonly live?: boolean
}) => {
  const style = { "--size": `${size}px`, ...identityColour(world, who) } as CSSProperties
  const name = actorName(world, who)
  /* Agents are rounded squares and people circles; an agent acting for a member wears that member's colour (M-34). */
  const delegated = actingFor(world, who) !== undefined || undefined
  if (isSmithers(who)) {
    return <span className="mvp-avatar" data-smithers data-for={delegated} data-live={live || undefined} style={style} title={name} aria-label={name}>S</span>
  }
  if (who === OUTSIDE) {
    return <span className="mvp-avatar" data-outside style={{ "--size": `${size}px` } as CSSProperties} title="Outside Smithers" aria-label="Outside Smithers">
      <FolderSync size={Math.round(size * 0.58)} aria-hidden="true" /></span>
  }
  const acting = via(who)
  if (acting !== undefined && !who.endsWith("~ssh")) {
    /* An agent a person runs (Claude Code, Codex) is its own participant: its initial on a square in their colour. */
    return <span className="mvp-avatar" data-external style={style} title={name} aria-label={name}>{acting.agent.charAt(0)}</span>
  }
  if (acting !== undefined) {
    /* A person over SSH is still that person: their circle with a terminal badge. */
    const person = member(world, acting.person)
    return <span className="mvp-avatar" data-via style={style} title={name} aria-label={name}>{person?.initials ?? "?"}
      <span className="mvp-avatar-badge" data-ssh aria-hidden="true"><SquareTerminal size={Math.max(8, Math.round(size * 0.38))} /></span></span>
  }
  if (isAgent(who)) {
    return <span className="mvp-avatar" data-agent data-for={delegated} data-live={live || undefined} style={style}
      title={name} aria-label={name}><Bot size={Math.round(size * 0.62)} aria-hidden="true" /></span>
  }
  const person = member(world, who)
  return <span className="mvp-avatar" style={style} title={person?.name} aria-label={person?.name}>{person?.initials ?? "?"}</span>
}

export const AvatarStack = ({ world, who, max = 4 }: { readonly world: World; readonly who: ReadonlyArray<ActorId>; readonly max?: number }) => {
  if (who.length === 0) return null
  const shown = who.slice(0, max)
  return (
    <span className="mvp-avatar-stack" aria-label={who.map(each => actorName(world, each)).join(", ")}>
      {shown.map(each => <Avatar key={each} world={world} who={each} />)}
      {who.length > max ? <span className="mvp-avatar mvp-avatar-more">+{who.length - max}</span> : null}
    </span>
  )
}

/* ── Where ───────────────────────────────────────────────── */

export const BranchChip = ({ branch, onOpen }: { readonly branch: Branch; readonly onOpen?: () => void }) => {
  const body = <><GitBranch size={12} aria-hidden="true" /><span>{branch.name}</span>
    {branch.machine === "asleep" ? <Moon size={11} aria-label="asleep" /> : null}</>
  return onOpen === undefined
    ? <span className="mvp-branch-chip" data-machine={branch.machine}>{body}</span>
    : <button type="button" className="mvp-branch-chip" data-machine={branch.machine} onClick={onOpen} data-mock="branch-chip">{body}</button>
}

/* ── What state ──────────────────────────────────────────── */

const STATE_WORD: Record<TodoState, string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  "needs-you": "Needs you",
  paused: "Paused",
  "in-review": "In review",
  merged: "Merged",
  failed: "Failed",
  dropped: "Dropped"
}

export const StateGlyph = ({ state }: { readonly state: TodoState }) => {
  switch (state) {
    case "in-review": return <GitPullRequest className="mvp-glyph" data-state={state} size={14} aria-hidden="true" />
    case "merged": return <GitMerge className="mvp-glyph" data-state={state} size={14} aria-hidden="true" />
    case "failed": return <X className="mvp-glyph" data-state={state} size={14} aria-hidden="true" />
    case "dropped": return <CircleDashed className="mvp-glyph" data-state={state} size={14} aria-hidden="true" />
    case "paused": return <Pause className="mvp-glyph" data-state={state} size={13} aria-hidden="true" />
    default: return <span className="mvp-dot" data-state={state} aria-hidden="true" />
  }
}

/** The state word with the detail that state carries: queue place, current step. */
export const stateLabel = (todo: Todo, flow: ReadonlyArray<FlowStep>): string => {
  if (todo.state === "queued" && todo.queue !== undefined) return `Waiting for a machine · #${todo.queue}`
  if (todo.state === "working" && todo.step !== undefined) return `Working · ${flow.find(step => step.id === todo.step)?.title ?? todo.step}`
  return STATE_WORD[todo.state]
}

export const StatePill = ({ todo, flow }: { readonly todo: Todo; readonly flow: ReadonlyArray<FlowStep> }) => (
  <span className="mvp-state" data-state={todo.state}><StateGlyph state={todo.state} />{stateLabel(todo, flow)}</span>
)

/* ── How far ─────────────────────────────────────────────── */

export const StepStrip = ({ flow, todo, seq }: { readonly flow: ReadonlyArray<FlowStep>; readonly todo: Todo; readonly seq: number }) => {
  /* Evidence is per revision: while a new revision's checks or review run, the strip is back at that step. */
  const rerun = todo.state === "in-review" && todo.evidence !== undefined
    && (todo.evidence.checks.some(check => check.state === "running") || todo.evidence.github.passed < todo.evidence.github.total)
  const rereview = todo.state === "in-review" && todo.evidence?.reviewing === true
  const back = rerun ? flow.findIndex(step => step.id === "verify") : rereview ? flow.findIndex(step => step.id === "review") : -1
  const current = back >= 0 ? back : todo.state === "in-review" || todo.state === "merged" ? flow.length : flow.findIndex(step => step.id === todo.step)
  /* One attempt is one durable run: after Propose it holds at a wait for merge, and a rebase loops it back to Verify. */
  const wait = todo.state === "merged" ? "done" : todo.state === "in-review" && back < 0 ? "held" : "next"
  return (
    <ol className="mvp-steps" aria-label="Flow steps">
      {flow.map((step, index) => {
        const phase = index < current ? "done" : index === current ? (todo.state === "needs-you" ? "waiting" : todo.state === "failed" ? "failed" : todo.state === "paused" ? "paused" : "current") : "next"
        return (
          <li key={step.id} data-phase={phase} data-new={step.seq === seq || undefined}
            aria-current={phase === "current" || phase === "waiting" ? "step" : undefined}>
            <span className="mvp-step-mark" aria-hidden="true">{phase === "done" ? <Check size={10} strokeWidth={3} /> : null}</span>
            <span className="mvp-step-name">{step.title}</span>
          </li>
        )
      })}
      <li data-phase={wait} data-wait aria-current={wait === "held" ? "step" : undefined}>
        <span className="mvp-step-mark" aria-hidden="true">{wait === "done" ? <Check size={10} strokeWidth={3} /> : null}</span>
        <span className="mvp-step-name">Merge</span>
      </li>
    </ol>
  )
}

/* ── Card chrome (the app's own .smithers-card anatomy) ──── */

/** True inside the maximized overlay: the same card, larger, with Restore in place of Maximize. */
export const Maximized = createContext(false)

export const Card = ({ id, kind, title, status, end, children, dim = false, focused = false }: {
  readonly id: string
  readonly kind: string
  readonly title: ReactNode
  readonly status?: ReactNode
  /** Right-aligned header content before the maximize button: presence, machine state. */
  readonly end?: ReactNode
  readonly children: ReactNode
  /** A sleeping branch's surfaces read from stored state and show dimmed. */
  readonly dim?: boolean
  /** The control-focus spotlight: this card owns the person's input. */
  readonly focused?: boolean
}) => {
  const max = useContext(Maximized)
  return (
    <section className="smithers-card mvp-card" data-kind={kind} data-mock={`card-${kind}${max ? "-max" : ""}`} data-card={id} data-dim={dim || undefined}
      data-maximized={max || undefined} data-focused={focused || undefined} aria-label={typeof title === "string" ? title : undefined}>
      <header className="smithers-card-header">
        <span className="smithers-card-title">{title}</span>
        {status}
        <span className="mvp-card-head-end">
          {end}
          {max
            ? <Button variant="ghost" size="sm" className="card-minimize-btn" aria-label="Restore" data-mock="restore"><Minimize2 size={13} />Restore</Button>
            : <Button variant="ghost" size="icon" className="card-maximize-btn" aria-label="Maximize card" title="Maximize card" data-mock={`maximize-${kind}`}><Maximize2 size={13} /></Button>}
        </span>
      </header>
      <div className="smithers-card-body">{children}</div>
    </section>
  )
}

/* The GitHub mark, as the app's signup draws it (apps/app cards/SignupCards.tsx): things that live on or came from GitHub. */
export const GitHubMark = ({ size = 13 }: { readonly size?: number }) => <svg className="mvp-gh" aria-label="GitHub" role="img" viewBox="0 0 24 24" width={size} height={size} fill="currentColor"><path d="M12 .5A11.5 11.5 0 0 0 8.36 22.9c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.12v3.14c0 .31.2.67.8.56A11.5 11.5 0 0 0 12 .5z" /></svg>

/** A TODO's reference, the same mono chip everywhere it appears. */
export const Ref = ({ world, todo }: { readonly world: World; readonly todo: Todo }) => <span className="mvp-ref-chip">{refOf(world, todo)}</span>

/*
 * What the agent's preflight put in its context (the conversation is not the context window). Collapsed to a
 * count; a person opens it for themselves, and the open state is theirs (views["context:<id>"]).
 */
export const ContextChip = ({ id, items, open }: { readonly id: string; readonly items: ReadonlyArray<string>; readonly open: boolean }) => (
  <span className="mvp-context" data-open={open || undefined}>
    <button type="button" className="mvp-context-toggle" aria-expanded={open} data-mock={`context-${id}`}>
      <Layers size={12} aria-hidden="true" />Context · {items.length}</button>
    {open ? items.map(item => <span key={item} className="mvp-context-chip" data-copy="data">{item}</span>) : null}
  </span>
)

export const Kbd = ({ children }: { readonly children: ReactNode }) => <kbd className="mvp-kbd">{children}</kbd>

export const agentOf = (branchId: string): ActorId => `${AGENT}:${branchId}`
