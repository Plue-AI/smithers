/*
 * A personal terminal on a branch's machine (mvp.md M-18). It runs as its
 * owner, with their own logins. Anyone on the branch can watch it; only the
 * owner types (shared typing is deferred, §16). The person driving it gets
 * the control-focus spotlight.
 */
import type { CSSProperties } from "react"
import { Button } from "@smthrs/ui"
import { Eye } from "lucide-react"
import { Avatar, BranchChip, Card } from "../parts"
import { typedOr, useFrame } from "../frame"
import { branch as branchOf, member, terminal as terminalOf, via } from "../world"

export const TerminalCard = ({ id, target }: { readonly id: string; readonly target: string }) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const session = terminalOf(world, target)
  const branch = branchOf(world, session.branch)
  /* A session the person's own agent runs ("Ben via Smithers") is still theirs to type into. */
  const mine = frame.me === session.owner || via(session.owner)?.person === frame.me
  const prompt = `${session.owner.startsWith("agent") ? "agent" : member(world, session.owner)?.name.split(" ")[0]?.toLowerCase() ?? "you"}@${branch.name} $`
  const typed = typedOr(frame, `terminal:${session.id}`, "")
  const focused = frame.state.viewers[frame.me]?.focus === id
  const freshIndex = session.lines.findIndex(line => line.seq === seq)
  return (
    <Card id={id} kind="terminal" title={session.title} focused={focused}
      status={<><BranchChip branch={branch} />{session.temporaryHome && mine ? <span className="mvp-term-temp" data-mock={`temp-home-${session.id}`}>Temporary home until next wake</span> : null}</>}
      end={<span className="mvp-term-people">
        <span className="mvp-term-person" title={`${member(world, session.owner)?.name}'s session`}><Avatar world={world} who={session.owner} size={20} /></span>
        {session.watchers.map(each => <span key={each} className="mvp-term-person" data-watching title={`${member(world, each)?.name} is watching`}>
          <Avatar world={world} who={each} size={20} /><Eye size={11} aria-hidden="true" /></span>)}
      </span>}>
      <div className="mvp-term" role="region" aria-label={`${session.title} output`}>
        {session.lines.map((line, index) => (
          <div key={index} className="mvp-term-line" data-tone={line.tone}
            style={freshIndex >= 0 && index >= freshIndex ? { "--delay": `${(index - freshIndex) * 70}ms` } as CSSProperties : undefined}
            data-fresh={line.seq === seq || undefined}>{line.text === "" ? " " : line.text}</div>
        ))}
        <div className="mvp-term-line" data-tone="prompt">{prompt} {typed}{focused ? <span className="mvp-term-cursor" aria-hidden="true" /> : null}</div>
      </div>
      {session.offer === undefined ? null : (
        <div className="mvp-rebase" data-mock={`offer-${session.id}`}>
          <span><code>{session.offer}</code> isn't on this machine</span>
          <span className="mvp-actions-end"><Button size="sm" variant="outline">Add to machine image</Button></span>
        </div>
      )}
      {mine ? null : <div className="mvp-actions mvp-term-foot"><span className="mvp-meta">Watching</span></div>}
    </Card>
  )
}
