import { ViewSkeleton } from "../ViewSkeleton"
import { KnowledgeGraphSurface } from "../ViewModules"
import { flowAction } from "../flows/FlowAction"
/*
 * The Wiki's link cards (Librarian L5): the rail of one note as a card
 * (`wiki-links`) and the knowledge graph as a card (`wiki-graph`). The
 * agent's wiki.backlinks and wiki.graph embed these in the transcript at
 * conversation width (THE EMBED LAW); the human's wiki.backlinks embeds the
 * same rail card. Every row is the button door of wiki.open, dispatched
 * through onRunCommand with the note's path as its args, so a click runs
 * exactly what `/wiki.open <path>` runs. A `[[target]]` no note answers is
 * listed under Unresolved with no door: there is nothing to open.
 */
import { Button } from "@smthrs/ui"
import { flowArgs } from "../flows/FlowArgs"
import { timeLabel } from "../Timestamps"
import { wikiContentPath } from "../wiki/CloudWiki"
import { Suspense, useMemo } from "react"
import type { Card, WorldDocument } from "../state/AppState"
import { WIKI_DISPLAY_NAME, WIKI_GRAPH_ALL_SCOPE } from "../state/AppState"
import { projectWikiGraph, projectWikiLinks } from "../state/WikiProjection"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

type WikiLinksCard = Extract<Card, { kind: "wiki-links" }>
type WikiGraphCard = Extract<Card, { kind: "wiki-graph" }>
type WikiHistoryCard = Extract<Card, { kind: "wiki-history" }>

export interface WikiCardActions {
  readonly onRunCommand: RunCommand
  /** Omitted only by isolated snapshot previews; an empty bound vault is authoritative. */
  readonly worldDocuments?: ReadonlyArray<WorldDocument>
}



const NoteRows = ({
  label,
  rows,
  empty,
  onRunCommand
}: {
  readonly label: string
  readonly rows: ReadonlyArray<{ readonly path: string; readonly title: string }>
  readonly empty: string
} & WikiCardActions) => (
  <section className="wiki-links-group" data-testid={`wiki-links-${label.toLowerCase().replace(/\s+/g, "-")}`}>
    <h4 className="search-results-group-label">
      {label} · {rows.length}
    </h4>
    {rows.length === 0 ?
      <p className="world-card-empty">{empty}</p> :
      (
        <ol className="search-results-items">
          {rows.map((row) => (
            <li key={row.path} className="search-results-item">
              <div className="world-card-row">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`wiki-open-${row.path}`}
                  {...flowAction(onRunCommand, "wiki.open", row.path)}
                >
                  {row.title}
                </Button>
                <span className="world-card-path">{row.path}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
  </section>
)

export const WikiLinksCardBody = ({ card, onRunCommand, worldDocuments }: { readonly card: WikiLinksCard } & WikiCardActions) => {
  const { payload } = useMemo(() => worldDocuments === undefined ? card : projectWikiLinks(card, worldDocuments), [card, worldDocuments])
  return (
    <div className="world-card-list wiki-links">
      <div className="world-card-row">
        <span className="world-card-path" data-testid="wiki-links-path">{payload.path}</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="wiki-links-open"
          {...flowAction(onRunCommand, "wiki.open", payload.path)}
        >
          Open
        </Button>
      </div>
      <NoteRows label="Backlinks" rows={payload.backlinks} empty="No backlinks yet" onRunCommand={onRunCommand} />
      <NoteRows label="Links out" rows={payload.linksOut} empty="No outgoing links yet" onRunCommand={onRunCommand} />
      {payload.unresolved.length === 0 ? null : (
        <section className="wiki-links-group" data-testid="wiki-links-unresolved">
          <h4 className="search-results-group-label">Unresolved · {payload.unresolved.length}</h4>
          <ol className="search-results-items">
            {payload.unresolved.map((target) => (
              <li key={target} className="search-results-item">
                <span className="world-card-path">[[{target}]]</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

export const WikiGraphCardBody = ({ card, onRunCommand, worldDocuments }: { readonly card: WikiGraphCard } & WikiCardActions) => {
  const { payload } = useMemo(() => worldDocuments === undefined ? card : projectWikiGraph(card, worldDocuments), [card, worldDocuments])
  const missing = payload.notes.filter((note) => note.missing).length
  return (
    <div className="world-card-list wiki-graph">
      <div className="world-card-row">
        <span className="world-card-path" data-testid="wiki-graph-scope">
          {payload.path === null ? WIKI_GRAPH_ALL_SCOPE : `Around ${payload.path}`} · {payload.notes.length - missing} note
          {payload.notes.length - missing === 1 ? "" : "s"} · {payload.links.length} link{payload.links.length === 1 ? "" : "s"}
          {missing === 0 ? "" : ` · ${missing} unresolved`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="wiki-graph-rerun"
          {...flowAction(onRunCommand, "wiki.graph", payload.path ?? undefined)}
        >
          Refresh
        </Button>
      </div>
      {payload.notes.length === 0 ?
        <p className="world-card-empty" data-testid="wiki-graph-empty">{WIKI_DISPLAY_NAME} is empty so far.</p> :
        (
          <div className="wiki-graph-canvas">
            <Suspense fallback={<ViewSkeleton />}>
              <KnowledgeGraphSurface
                notes={payload.notes.map((note) => ({
                  path: note.path,
                  title: note.title,
                  linksOut: [...note.linksOut],
                  backlinks: [...note.backlinks],
                  ...(note.missing ? { frontmatter: { missing: true } } : {})
                }))}
                links={payload.links}
                height={320}
                onOpenNote={(path) => onRunCommand("wiki.open", path)}
              />
            </Suspense>
          </div>
        )}
    </div>
  )
}

/**
 * A page's history (#1922): one row per revision, newest first, each the
 * link to that revision's own bytes (the scoped content route) — so a rename
 * or a deletion keeps every earlier version reachable.
 */
export const WikiHistoryCardBody = ({ card, onRunCommand }: { readonly card: WikiHistoryCard; readonly onRunCommand: RunCommand }) => {
  const { repo, space, pageId, slug, path, revisions, page, hasNext } = card.payload
  return (
    <div className="world-card-list wiki-history" data-testid="wiki-history" data-space={space}>
      <div className="world-card-row">
        <span className="world-card-path" data-testid="wiki-history-path">{path}</span>
        <span className="wiki-space-chip" data-space={space}>{space}</span>
      </div>
      {revisions.length === 0 ? <p className="world-card-empty">No revisions yet</p> : (
        <ol className="search-results-items" aria-label="Revisions">
          {revisions.map((row) => (
            <li key={row.revision} className="search-results-item" data-testid={`wiki-revision-${row.revision}`} data-deleted={row.deleted || undefined}>
              <div className="world-card-row">
                <a className="world-card-title" href={`/api${wikiContentPath(repo, space, pageId, row.revision)}`} download={row.path.split("/").pop()} target="_blank" rel="noreferrer">
                  r{row.revision}
                </a>
                <span className="world-card-path">{row.deleted ? "deleted" : row.path}</span>
                <span className="world-card-path">{row.author} · <time dateTime={row.at}>{timeLabel(Date.parse(row.at))}</time></span>
                {row.attachment === undefined ? null : <span className="world-card-path">{row.attachment.mediaType} · {row.attachment.size} B</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {page > 1 || hasNext ? <div className="wiki-card-pages">
        {page <= 1 ? null : <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "wiki.history", flowArgs("wiki.history", { slug, repo, page: page - 1, space }))}>Previous page</Button>}
        {hasNext ? <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "wiki.history", flowArgs("wiki.history", { slug, repo, page: page + 1, space }))}>Next page</Button> : null}
      </div> : null}
    </div>
  )
}

/** The family slice: the three kinds this file owns. */
export const wikiCardFamily: CardFamily<"wiki-links" | "wiki-graph" | "wiki-history"> = {
  "wiki-history": {
    render: (card, actions) => <WikiHistoryCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  "wiki-links": {
    render: (card, actions) => <WikiLinksCardBody card={card} onRunCommand={actions.onRunCommand} worldDocuments={actions.projectionStore === undefined ? undefined : actions.worldDocuments} />,
    pill: settledPill
  },
  "wiki-graph": {
    render: (card, actions) => <WikiGraphCardBody card={card} onRunCommand={actions.onRunCommand} worldDocuments={actions.projectionStore === undefined ? undefined : actions.worldDocuments} />,
    pill: settledPill
  }
}
