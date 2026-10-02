/*
 * The Branch card: the place (mvp.md §6.7). One card for the whole branch:
 * its machine, the item it works and that item's place in the repository's
 * stack, then everyone on the branch (every person and every agent,
 * what each is doing and where), the coding agent's activity with everyone's
 * steers, its files and terminals. Reading a sleeping branch never wakes it.
 */
import type { ReactNode } from "react"
import { Button } from "@smthrs/ui"
import { ChevronDown, Copy, FileCode2, GitFork, Moon, Play, SquareTerminal } from "lucide-react"
import { actorName, Avatar, AvatarStack, Card, ContextChip, GitHubMark, Ref, StatePill } from "../parts"
import { typedOr, useFrame } from "../frame"
import { placeOf } from "./Todo"
import { branch as branchOf, isAgent, OUTSIDE, refOf, type Activity, type Branch, type Presence, type World } from "../world"

/** The install's host, from the address the owner set in Settings. */
const hostOf = (world: World): string => {
  try { return new URL(world.setup.addresses[0] ?? "").hostname } catch { return "localhost" }
}

const MachineState = ({ branch }: { readonly branch: Branch }) => {
  switch (branch.machine) {
    case "awake": return <span className="mvp-machine-state" data-machine="awake"><span className="mvp-live-dot" aria-hidden="true" />Awake</span>
    case "asleep": return <span className="mvp-machine-state" data-machine="asleep"><Moon size={12} aria-hidden="true" />Asleep</span>
    case "waking": return <span className="mvp-machine-state" data-machine="waking"><span className="mvp-spin" aria-hidden="true" />Waking</span>
    case "waiting": return <span className="mvp-machine-state" data-machine="waiting">Waiting for a machine · #{branch.waitPosition ?? 1}</span>
    case "closed": return <span className="mvp-machine-state" data-machine="closed">Closed</span>
  }
}

/** What each one is doing, in a word, and where, as a link to that place. */
const doing = (world: World, presence: Presence): { verb: string; where: ReactNode } => {
  const { where } = presence
  switch (where.kind) {
    case "file": return { verb: "editing", where: <><FileCode2 size={12} aria-hidden="true" />{where.path.split("/").at(-1)}{where.line === undefined ? "" : `:${where.line}`}</> }
    case "terminal": {
      const session = world.terminals.find(each => each.id === where.id)
      if (where.watching) return { verb: "watching", where: <><SquareTerminal size={12} aria-hidden="true" />{session?.title ?? "terminal"}</> }
      return { verb: session?.running === undefined ? "in" : "running", where: <><SquareTerminal size={12} aria-hidden="true" />{session?.title ?? "terminal"}{session?.running === undefined ? "" : ` · ${session.running}`}</> }
    }
    case "step": return { verb: "at", where: <><Play size={11} aria-hidden="true" />{world.flow.find(step => step.id === where.step)?.title ?? where.step}</> }
    case "branch": return { verb: "here", where: null }
  }
}

/* Everyone on the branch: people first, then agents, each with what it is doing. */
const Present = ({ world, branch }: { readonly world: World; readonly branch: Branch }) => {
  const people = branch.presence.filter(each => !isAgent(each.who))
  const agents = branch.presence.filter(each => isAgent(each.who))
  return (
    <ul className="mvp-present" aria-label="On this branch">
      {[...people, ...agents].map(presence => {
        const { verb, where } = doing(world, presence)
        return (
          <li key={presence.who} data-mock={`here-${presence.who}`} data-agent={isAgent(presence.who) || undefined}>
            <Avatar world={world} who={presence.who} size={22} live={presence.who.startsWith("agent:") && branch.machine === "awake"} />
            <span className="mvp-ws-name">{actorName(world, presence.who)}</span>
            <span className="mvp-ws-verb">{verb}</span>
            <span className="mvp-ws-places">
              {where === null ? null : <button type="button" className="mvp-ws-where" data-mock={`where-${presence.who}`}>{where}</button>}
              {presence.watching === undefined ? null : <button type="button" className="mvp-ws-where mvp-ws-also" data-mock={`watching-${presence.who}`}>
                <span className="mvp-ws-verb">watching</span>{world.terminals.find(each => each.id === presence.watching)?.title ?? "terminal"}</button>}
            </span>
          </li>
        )
      })}
      {branch.presence.length === 0 ? <li className="mvp-ws-empty">Nobody here</li> : null}
    </ul>
  )
}

const ActivityRow = ({ world, item, seq, answered, open = false }: { readonly world: World; readonly item: Activity; readonly seq: number; readonly answered: boolean; readonly open?: boolean }) => item.kind === "change" ? (
  <li className="mvp-activity-row" data-kind="change" data-fresh={item.seq === seq || undefined}>
    <Avatar world={world} who={item.who} size={20} />
    <button type="button" className="mvp-activity-text mvp-activity-open" data-mock={`change-${item.id}`}>
      {item.who === OUTSIDE ? <>Changed outside Smithers · {item.files} {item.files === 1 ? "file" : "files"}</>
        : <><b>{actorName(world, item.who)}</b> changed {item.files} {item.files === 1 ? "file" : "files"}</>}</button>
  </li>
) : item.kind === "read" ? (
  /* B.3: read, ls, glob and grep render as one line; each file opens its File card. */
  <li className="mvp-activity-row" data-kind="read" data-fresh={item.seq === seq || undefined}>
    <Avatar world={world} who={item.who} size={20} />
    <span className="mvp-activity-text"><span className="mvp-activity-tag">Read</span>
      {(item.items ?? []).map(path => <button key={path} type="button" className="mvp-file-link" data-mock={`read-${path}`}>{path.split("/").at(-1)}</button>)}</span>
  </li>
) : item.kind === "context" ? (
  /* B.3: memory and recall render as the Context chip: what preflight put in front of the agent. */
  <li className="mvp-activity-row" data-kind="context" data-fresh={item.seq === seq || undefined}>
    <Avatar world={world} who={item.who} size={20} />
    <span className="mvp-activity-text"><ContextChip id={item.id} items={item.items ?? []} open={open} /></span>
  </li>
) : (
  <li className="mvp-activity-row" data-kind={item.kind} data-tone={item.tone} data-answered={answered || undefined} data-fresh={item.seq === seq || undefined}>
    <Avatar world={world} who={item.who} size={20} />
    <span className="mvp-activity-text">
      {item.asked === undefined ? null : <span className="mvp-asked">{actorName(world, item.asked)} asked ·</span>}
      {item.kind === "steer" ? <span className="mvp-activity-tag">Steer</span> : null}
      {item.kind === "answer" ? <span className="mvp-activity-tag">Answer</span> : null}
      {item.github ? <GitHubMark size={12} /> : null}
      {item.kind === "question" ? <span className="mvp-activity-tag" data-tone={answered ? undefined : "attention"}>{answered ? "Asked" : "Asks"}</span> : null}
      {item.kind === "steer" || item.kind === "answer" || item.kind === "question" ? <span data-copy="data">{item.text}</span> : item.text}
    </span>
  </li>
)

/** Embedded, the card shows the latest activity; maximized shows it all. */
const RECENT = 5
const TABS = ["activity", "files", "terminals"] as const

export const BranchCard = ({ id, target, view }: { readonly id: string; readonly target: string; readonly view?: string }) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const branch = branchOf(world, target)
  const item = branch.item === undefined ? undefined : world.todos.find(each => each.id === branch.item)
  const tab = TABS.includes(view as (typeof TABS)[number]) ? view : "activity"
  const terminals = world.terminals.filter(each => each.branch === branch.id)
  const changed = world.files.filter(each => each.branch === branch.id && each.lines.some(line => line.by !== undefined))
  const dim = branch.machine === "asleep" || branch.machine === "closed"
  /* A scratch branch adds after the item of the branch it forked from. */
  const origin = world.branches.find(each => each.id === branch.from)?.item
  const forkedFrom = origin === undefined ? undefined : world.todos.find(each => each.id === origin)
  return (
    <Card id={id} kind="branch" title={branch.name} status={<MachineState branch={branch} />} dim={dim}>
      <div className="mvp-meta mvp-branch-item">
        {item === undefined ? <span className="mvp-scratch">Scratch</span> : <>
          <StatePill todo={item} flow={item.steps ?? world.flow} />
          <Ref world={world} todo={item} />
          <button type="button" className="mvp-link" data-mock={`item-${item.id}`}>{item.title}</button>
          <span>{placeOf(world, item)}</span>
        </>}
        {item === undefined && branch.machine !== "closed" ? (
          <span className="mvp-place">
            <Button size="sm" variant="solid" data-mock="add-to-stack" aria-expanded={view === "add"}>Add to stack<ChevronDown size={14} aria-hidden="true" /></Button>
            {view === "add" ? (
              <div className="mvp-menu" role="menu">
                {forkedFrom === undefined
                  ? <button type="button" role="menuitem" data-mock="add-append">New TODO at the end of the stack</button>
                  : <button type="button" role="menuitem" data-mock="add-after">New TODO after <b>{refOf(world, forkedFrom)} {forkedFrom.title}</b></button>}
              </div>
            ) : null}
          </span>
        ) : null}
      </div>
      {branch.movedOff === undefined ? null : (
        <div className="mvp-rebase" data-mock="moved-off">
          <span className="mvp-dot" data-state="needs-you" aria-hidden="true" />
          <span>{actorName(world, branch.movedOff.by)} moved this branch off {(() => { const moved = world.todos.find(each => each.id === branch.movedOff!.item); return moved === undefined ? "its item" : refOf(world, moved) })()}</span>
          <span className="mvp-actions-end">
            <Button size="sm" variant="solid">Return to {(() => { const moved = world.todos.find(each => each.id === branch.movedOff!.item); return moved === undefined ? "its item" : refOf(world, moved) })()}</Button>
            <Button size="sm" variant="ghost">Keep for now</Button>
          </span>
        </div>
      )}
      {branch.rebasePending === undefined ? null : (
        <div className="mvp-rebase">
          <span>Rebase pending onto {branch.rebasePending}</span>
          <span className="mvp-actions-end"><Button size="sm" variant="outline" data-mock={`rebase-${branch.id}`}>Rebase now</Button></span>
        </div>
      )}
      <Present world={world} branch={branch} />
      <div className="mvp-tabs" role="tablist" aria-label={`${branch.name} views`}>
        <button type="button" role="tab" aria-selected={tab === "activity"} data-mock="tab-activity">Activity</button>
        <button type="button" role="tab" aria-selected={tab === "files"} data-mock="tab-files">Files{changed.length > 0 ? <b>{changed.length}</b> : null}</button>
        <button type="button" role="tab" aria-selected={tab === "terminals"} data-mock="tab-terminals">Terminals{terminals.length > 0 ? <b>{terminals.length}</b> : null}</button>
      </div>
      {tab === "activity" ? (
        <ol className="mvp-activity">
          {branch.activity.length > RECENT ? <li className="mvp-activity-more">{branch.activity.length - RECENT} earlier</li> : null}
          {branch.activity.slice(-RECENT).map(entry => <ActivityRow key={entry.id} world={world} item={entry} seq={seq}
            answered={entry.kind === "question" && item?.question?.answer !== undefined} open={frame.state.viewers[frame.me]?.views[`context:${entry.id}`] === "open"} />)}
        </ol>
      ) : tab === "files" ? (
        <ul className="mvp-list">
          {changed.map(doc => {
            const editors = [...new Set(doc.lines.flatMap(line => line.by === undefined ? [] : [line.by]))]
            return <li key={doc.path}><button type="button" className="mvp-list-row" data-mock={`file-${doc.path}`}>
              <FileCode2 size={14} aria-hidden="true" /><span className="mvp-mono">{doc.path}</span>
              <AvatarStack world={world} who={editors} /></button></li>
          })}
        </ul>
      ) : (
        <ul className="mvp-list">
          {terminals.map(session => (
            <li key={session.id}><button type="button" className="mvp-list-row" data-mock={`terminal-${session.id}`}>
              <SquareTerminal size={14} aria-hidden="true" /><span>{session.title}</span>
              {session.running === undefined ? null : <span className="mvp-mono mvp-muted">{session.running}</span>}
              <AvatarStack world={world} who={[session.owner, ...session.watchers]} /></button></li>
          ))}
        </ul>
      )}
      {item !== undefined && branch.machine !== "closed" ? (() => {
        const asking = item.question !== undefined && item.question.answer === undefined && (item.needs === undefined || item.needs === "question" || item.needs === "approval")
        return (
          <form className="mvp-inline-input mvp-steer" onSubmit={event => event.preventDefault()}>
            <input aria-label={asking ? "Answer the coding agent" : "Steer the coding agent"} placeholder={asking ? "Answer the coding agent" : "Steer the coding agent"} readOnly
              value={typedOr(frame, `steer:${branch.id}`, "")} data-mock={`steer-input-${branch.id}`} />
            {asking ? <Button size="sm" variant="solid" data-mock={`branch-answer-${branch.id}`}>Answer</Button> : null}
            <Button size="sm" variant="outline" data-mock={`steer-send-${branch.id}`}>Steer</Button>
          </form>
        )
      })() : null}
      {branch.machine === "closed" ? (
        <div className="mvp-actions"><Button size="sm" variant="outline" data-mock="fork"><GitFork size={14} aria-hidden="true" />Fork</Button></div>
      ) : (
        <div className="mvp-actions">
          <Button size="sm" variant="ghost" data-mock={`new-terminal-${branch.id}`}><SquareTerminal size={14} aria-hidden="true" />New terminal</Button>
          <Button size="sm" variant="ghost" data-mock={`ssh-${branch.id}`} aria-expanded={view === "ssh"}>SSH</Button>
          <Button size="sm" variant="ghost" data-mock="fork"><GitFork size={14} aria-hidden="true" />Fork</Button>
          {view === "ssh" ? <code className="mvp-copy-line mvp-ssh-line">ssh -p 2222 {branch.name}@{hostOf(world)}<span className="mvp-copied"><Copy size={12} aria-hidden="true" />Copied</span></code> : null}
        </div>
      )}
    </Card>
  )
}
