import { Button, FileTree } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useContext, useState, useSyncExternalStore } from "react"
import { ControllerContext } from "../ControllerContext"
import { flowAction, flowProps } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import type { RunCommand } from "../cards/CardFamily"
import type { WikiIndexPage, WikiIndexRow, WikiSpace, WorldDocument } from "../state/AppState"
import { resolveTargetRepo } from "../state/RepoContext"
import { wikiContentPath, wikiDocumentId } from "./CloudWiki"
import { wikiIndexFailure } from "./CloudWikiFailure"
import { FailureNotice } from "../FailureNotice"

/*
 * The wiki's navigation (#1922), shared by the Wiki pane and the Wiki card:
 * the space switch (public | private), and the tree of one space — its
 * folders and pages from the navigation index, narrowed by a search or a
 * tag. Every row is the button door of a registered flow: a Markdown page
 * opens through wiki.cloud.open (or wiki.select once it is loaded), an
 * attachment through wiki.select by its page id. Local notes (no repository,
 * or signed out) list as before, through wiki.select.
 */

export interface WikiScope {
  readonly repo: string | null
  readonly space: WikiSpace
  readonly index: WikiIndexRow | undefined
}

const NO_INDEXES = { get: () => undefined, subscribe: () => () => {} }

/** The space's index and repository, read live off the store. */
export const useWikiScope = (spaceOverride?: WikiSpace): WikiScope => {
  const controller = useContext(ControllerContext)
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: controller!.store.collections.sessions }).select(({ session }) => ({ id: session.id, wikiSpace: session.wikiSpace, activeRepoKey: session.activeRepoKey })))
  useLiveQuery(controller!.store.collections.workingCopies)
  useLiveQuery(controller!.store.collections.repositories)
  const space = spaceOverride ?? sessionRows[0]?.wikiSpace ?? controller!.store.session().wikiSpace ?? "public"
  /* The repository the wiki belongs to: the selected one, else the one loaded repository (the same reading every wiki door takes). */
  const target = resolveTargetRepo(controller!.store, undefined)
  const repo = "error" in target ? null : target.repo
  // Isolated previews and tests mount without the store; an absent store lists no space, as before spaces existed.
  const store = controller?.wikiIndexes ?? NO_INDEXES
  const index = useSyncExternalStore(store.subscribe, () => repo === null ? undefined : store.get(repo, space), () => repo === null ? undefined : store.get(repo, space))
  return { repo, space, index }
}

/** The switch: two doors of wiki.space, the shown one pressed. */
export const WikiSpaceSwitch = ({ space, repo, onRunCommand }: { readonly space: WikiSpace; readonly repo?: string; readonly onRunCommand: RunCommand }) => (
  <div className="wiki-space-switch" role="group" aria-label="Wiki space" data-testid="wiki-space-switch">
    {(["public", "private"] as const).map((candidate) => (
      <Button key={candidate} size="sm" variant="ghost" aria-pressed={space === candidate} data-testid={`wiki-space-${candidate}`}
        {...flowAction(onRunCommand, "wiki.space", flowArgs("wiki.space", { space: candidate, ...(repo === undefined ? {} : { repo }) }))}>
        {candidate === "public" ? "Public" : "Private"}
      </Button>
    ))}
  </div>
)

/** The page an index row names, as a document id (loaded or not). */
export const indexDocumentId = (repo: string, page: Pick<WikiIndexPage, "id">): string => wikiDocumentId(repo, page.id)

/** A page's backlinks and links out, as paths, from the index (server-resolved). */
export const indexLinksOf = (index: WikiIndexRow | undefined, pageId: number): { readonly backlinks: ReadonlyArray<string>; readonly linksOut: ReadonlyArray<string>; readonly unresolved: ReadonlyArray<string> } | undefined => {
  const page = index?.pages.find((row) => row.id === pageId)
  if (page === undefined || index === undefined) return undefined
  const byId = new Map(index.pages.map((row) => [row.id, row.path] as const))
  return {
    backlinks: [...new Set(page.backlinks.map((row) => row.path))],
    linksOut: [...new Set(page.links.flatMap((link) => link.pageId === undefined ? [] : [byId.get(link.pageId) ?? link.target]))],
    unresolved: [...new Set(page.links.filter((link) => link.pageId === undefined).map((link) => link.target))]
  }
}

/** The index page a path names, when the space lists one. */
export const indexPageAt = (index: WikiIndexRow | undefined, path: string): WikiIndexPage | undefined =>
  index?.pages.find((row) => row.path === path || row.path.toLowerCase() === path.toLowerCase())

/** Whether an index page is an attachment (bytes) rather than a Markdown page. */
export const isAttachment = (page: Pick<WikiIndexPage, "attachment">): boolean => page.attachment !== undefined

/** The route an image or a download of an attachment's current revision reads. */
export const attachmentUrl = (repo: string, space: WikiSpace, page: Pick<WikiIndexPage, "id" | "revision">): string =>
  `/api${wikiContentPath(repo, space, page.id, page.revision)}`

export const WikiTree = ({ scope, documents, selectedId, onRunCommand, testId = "wiki-tree" }: {
  readonly scope: WikiScope
  /** The loaded documents, for the local notes and for a page already open. */
  readonly documents: ReadonlyArray<WorldDocument>
  readonly selectedId: string | undefined
  readonly onRunCommand: RunCommand
  readonly testId?: string
}) => {
  /*
   * The search and the tag narrow what the tree shows; both are transient
   * chrome no reader would miss after a reload (AGENTS: useState exempt).
   */
  const [query, setQuery] = useState("")
  const [tag, setTag] = useState<string | null>(null)
  const { repo, space, index } = scope
  const needle = query.trim().toLowerCase()
  if (repo === null || index === undefined) {
    // No space to list: the local notes, the pane's notes since before spaces.
    const notes = documents.filter((document) => document.cloud === undefined || (document.cloud.repo === repo && (document.cloud.visibility ?? "public") === space))
    const shown = needle === "" ? notes : notes.filter((note) => `${note.title} ${note.path}`.toLowerCase().includes(needle))
    return <div className="wiki-tree" data-testid={testId}>
      <input className="wiki-tree-search" type="search" aria-label="Search pages" placeholder="Search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      <FileTree nodeProps={() => flowProps("wiki.select")} nodes={shown.map((note) => ({ path: note.path, label: note.title }))}
        selected={documents.find((document) => document.id === selectedId)?.path}
        onSelect={(path) => { const note = documents.find((candidate) => candidate.path === path); if (note) onRunCommand("wiki.select", note.id) }} />
    </div>
  }
  const pages = index.pages.filter((page) =>
    (tag === null || page.tags.includes(tag)) &&
    (needle === "" || `${page.title} ${page.path} ${page.aliases.join(" ")}`.toLowerCase().includes(needle)))
  const selectedPath = index.pages.find((page) => indexDocumentId(repo, page) === selectedId)?.path
  const indexFailure = wikiIndexFailure(index)
  return <div className="wiki-tree" data-testid={testId} data-space={space}>
    <input className="wiki-tree-search" type="search" aria-label="Search pages" placeholder="Search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
    {index.tags.length === 0 ? null : <div className="wiki-tree-tags" role="group" aria-label="Tags">
      {index.tags.map((candidate) => <button key={candidate} type="button" className="wiki-tag" aria-pressed={tag === candidate}
        onClick={() => setTag(tag === candidate ? null : candidate)}>#{candidate}</button>)}
    </div>}
    {indexFailure === null ? null : <FailureNotice failure={indexFailure} className="wiki-tree-error" data-testid="wiki-tree-error"
      actions={{ retry: flowAction(onRunCommand, "wiki.space", flowArgs("wiki.space", { space, repo })) }} />}
    <FileTree
      nodeProps={(node) => { const page = indexPageAt(index, node.path); return page !== undefined && !isAttachment(page) && !documents.some((document) => document.id === indexDocumentId(repo, page)) ? flowProps("wiki.cloud.open") : flowProps("wiki.select") }}
      nodes={pages.map((page) => ({ path: page.path, label: isAttachment(page) ? page.path.split("/").pop() ?? page.path : page.title }))}
      directories={needle === "" && tag === null ? index.folders : []}
      selected={selectedPath}
      onSelect={(path) => {
        const page = indexPageAt(index, path)
        if (page === undefined) return
        const id = indexDocumentId(repo, page)
        if (isAttachment(page) || documents.some((document) => document.id === id)) onRunCommand("wiki.select", id)
        else onRunCommand("wiki.cloud.open", flowArgs("wiki.cloud.open", { slug: page.slug, repo, space }))
      }} />
  </div>
}

/** The way a `[[link]]` path opens in this space: its page's door, or nothing when the space has no such page. */
export const openIndexPath = (scope: WikiScope, documents: ReadonlyArray<WorldDocument>, onRunCommand: RunCommand, path: string): void => {
  const page = indexPageAt(scope.index, path)
  if (page === undefined || scope.repo === null) { onRunCommand("wiki.open", path); return }
  const id = indexDocumentId(scope.repo, page)
  if (isAttachment(page) || documents.some((document) => document.id === id)) onRunCommand("wiki.select", id)
  else onRunCommand("wiki.cloud.open", flowArgs("wiki.cloud.open", { slug: page.slug, repo: scope.repo, space: scope.space }))
}
