/*
 * The Wiki card: one page of the repository's vault (mvp.md §6.11), rendered
 * from its Markdown and co-edited live in the File card's language (Code.tsx).
 * Each person's changed characters carry their colour, every other editor has
 * a name flag in the margin on their block, and only your own typing shows a
 * caret. There is no Save button: a burst of edits saves as the page's next
 * revision once it settles, and a plan cites the revision it read. A decision
 * a learning run wrote sits in a Decision block with the change it came from.
 */
import { Fragment, type CSSProperties, type ReactNode } from "react"
import { BookOpen, Link2, Signpost } from "lucide-react"
import { actorName, Avatar, Card, flagName, identityColour, Ref } from "../parts"
import { useFrame } from "../frame"
import { wikiPage, type ActorId, type World } from "../world"
import type { ExtraCardProps } from "./extra"

const colourOf = (world: World, who: ActorId): CSSProperties => identityColour(world, who)


/** The characters `next` changed from `prev`: [from, to) in `next`, their common ends trimmed. */
const changedOf = (prev: string, next: string): readonly [number, number] => {
  const most = Math.min(prev.length, next.length)
  let from = 0
  while (from < most && prev[from] === next[from]) from += 1
  let tail = 0
  while (tail < most - from && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1
  return [from, next.length - tail]
}

/** A block's inline Markdown: `code` spans, with the changed characters marked. */
const Inline = ({ text, changed, mark }: { readonly text: string; readonly changed?: readonly [number, number]; readonly mark: (span: string) => ReactNode }) => {
  let at = 0
  return <>{text.split("`").map((piece, index) => {
    const start = at
    at += piece.length + 1
    const [from, to] = changed === undefined ? [0, 0] : [Math.max(changed[0] - start, 0), Math.min(changed[1] - start, piece.length)]
    const body = from >= to ? piece : <>{piece.slice(0, from)}{mark(piece.slice(from, to))}{piece.slice(to)}</>
    return index % 2 === 1 ? <code key={index}>{body}</code> : <Fragment key={index}>{body}</Fragment>
  })}</>
}

export const WikiCard = ({ id, target }: ExtraCardProps) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const page = wikiPage(world, target)
  const editors = page.editors ?? []
  const mine = editors.find(each => each.who === frame.me)?.line
  const typedOf = (n: number): string | undefined => frame.typed[`wiki:${page.id}:${n}`]
  /* Edits since the latest revision become the next one once the burst settles. */
  const saving = page.lines.some(line => typedOf(line.n) !== undefined || (line.seq ?? -1) > page.seq)
  const { decision } = page
  return (
    <Card id={id} kind="wiki" title={page.title}
      status={(
        <span className="mvp-wiki-rev" title={`r${page.rev} by ${page.authors.map(each => actorName(world, each)).join(" and ")}`}>
          <span className="mvp-wiki-rev-chip" data-fresh={page.seq === seq || undefined}><BookOpen size={12} aria-hidden="true" />r{page.rev}</span>
          <span className="mvp-wiki-authors">{page.authors.map(each => <Avatar key={each} world={world} who={each} size={18} />)}</span>
        </span>
      )}
      end={saving ? <span className="mvp-saved" data-saving><span className="mvp-saving-mark" aria-hidden="true" />Saving…</span> : undefined}>
      <div className="mvp-wiki-doc" role="group" aria-label={`${page.title}, r${page.rev}`} tabIndex={0}>
        {page.lines.map(line => {
          const typed = typedOf(line.n)
          const text = typed ?? line.text
          /* Live typing is measured against the block as saved; a saved edit against the revision before it. */
          const author = typed === undefined ? (line.was === undefined ? undefined : line.by) : editors.find(each => each.line === line.n)?.who
          const changed = author === undefined ? undefined : changedOf(typed === undefined ? line.was ?? line.text : line.text, text)
          const others = editors.filter(each => each.line === line.n && each.who !== frame.me).map(each => each.who)
          const callout = decision === undefined || line.n < decision.from || line.n > decision.to ? undefined : line.n === decision.to ? "last" : "body"
          return (
            <Fragment key={line.n}>
              {decision !== undefined && line.n === decision.from ? (
                <div className="mvp-wiki-row">
                  <span className="mvp-wiki-flag" />
                  <div className="mvp-wiki-block mvp-wiki-head" data-callout="head">
                    <Signpost size={13} aria-hidden="true" />Decision
                    <span className="mvp-wiki-by">
                      <Avatar world={world} who={decision.by} size={16} />Learning<span aria-hidden="true">·</span>
                      <a className="mvp-wiki-change" href="#" data-mock="wiki-change">#{decision.change} ↗</a>
                    </span>
                  </div>
                </div>
              ) : null}
              <div className="mvp-wiki-row">
                <span className="mvp-wiki-flag">{others[0] === undefined ? null : (
                  <span className="mvp-code-flag" style={colourOf(world, others[0])} title={others.map(each => actorName(world, each)).join(", ")}>
                    <span className="mvp-code-flag-name">{flagName(world, others[0])}</span>{others.length > 1 ? <b>+{others.length - 1}</b> : null}
                  </span>
                )}</span>
                <p className="mvp-wiki-block" data-callout={callout} data-active={line.n === mine || undefined} data-mock={`wiki-line-${line.n}`} data-copy="data">
                  <Inline text={text} changed={changed} mark={span => author === undefined ? span : (
                    <span className="mvp-span" data-fresh={typed === undefined && line.seq === seq ? true : undefined}
                      style={colourOf(world, author)} title={actorName(world, author)}>{span}</span>
                  )} />
                  {typed !== undefined && author === frame.me ? <span className="mvp-caret" style={colourOf(world, frame.me)} aria-hidden="true" /> : null}
                </p>
              </div>
            </Fragment>
          )
        })}
      </div>
      {(page.cited ?? []).map(cite => {
        const item = world.todos.find(each => each.id === cite.todo)
        return item === undefined ? null : (
          <div key={cite.todo} className="mvp-wiki-row">
            <span className="mvp-wiki-flag" />
            <button type="button" className="mvp-wiki-cited" data-mock={`wiki-cited-${cite.todo}`} data-fresh={cite.seq === seq || undefined}>
              <Link2 size={13} aria-hidden="true" />Cited by <Ref world={world} todo={item} /><span className="mvp-mono">r{cite.rev}</span>
            </button>
          </div>
        )
      })}
    </Card>
  )
}
