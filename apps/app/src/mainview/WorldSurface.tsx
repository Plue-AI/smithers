import { ViewSkeleton } from "./ViewSkeleton"
import { MarkdownEditorSurface, KnowledgeGraphSurface } from "./ViewModules"
import { flowAction, flowProps } from "./flows/FlowAction"
import { flowArgs } from "./flows/FlowArgs"
import { fileGesture } from "./flows/CommandGesture"
import { Button, EmptyState } from "@smthrs/ui"
import { BacklinksPanel, OutlineView } from "@smthrs/ui/vault"
import { useLiveQuery } from "@tanstack/react-db"
import { BookOpen, History, Paperclip, Pencil, Plus, Trash2, Waypoints } from "lucide-react"
import { Suspense, useMemo, useRef } from "react"
import { activeRepositoryId } from "./state/RepoContext"
import { useController } from "./ControllerContext"
import { WIKI_DISPLAY_NAME, WIKI_GRAPH_ALL_SCOPE } from "./state/AppState"
import type { WorldDocument } from "./state/AppState"
import { SurfaceHeader } from "./SurfaceChrome"
import { attachmentUrl, indexDocumentId, indexLinksOf, isAttachment, openIndexPath, useWikiScope, WikiSpaceSwitch, WikiTree } from "./wiki/WikiNavigation"
import { linkGraphOf, linksOf, neighbourhoodOf } from "./wiki/VaultAdapter"


/* The Wiki pane's graph mode renders over d3-force; it loads on first use like the editor. */


/*
 * The Wiki pane beside the chat (#1922): one wiki per repository with a
 * public part and a private part, shaped like Obsidian — the space switch,
 * the tree of folders and pages, the open page's editor, its backlinks and
 * outline in the rail, or the graph mode. It reads its own session fields,
 * so selecting a page repaints this pane and not the transcript.
 * `documents` is the shell's path-ordered list, the same array the cards read.
 */
export function WorldSurface({ documents }: { readonly documents: ReadonlyArray<WorldDocument> }) {
  const controller = useController()
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({
      id: session.id,
      selectedWorldDocumentId: session.selectedWorldDocumentId,
      wikiPane: session.wikiPane,
      wikiGraphPath: session.wikiGraphPath
    }))
  )
  const session = sessionRows[0] ?? controller.store.session()
  const scope = useWikiScope()
  const { repo, space, index } = scope
  /* The documents of this space (or the local notes): a page of the other space is never on screen here. */
  const shown = useMemo(() => documents.filter((document) => document.cloud === undefined || (document.cloud.repo === repo && (document.cloud.visibility ?? "public") === space)), [documents, repo, space])
  const selectedId = session.selectedWorldDocumentId ?? undefined
  const selected = shown.find((document) => document.id === selectedId) ?? (index === undefined ? shown[0] : undefined)
  /* An attachment has no document: the index row is what is open. */
  const attachment = repo === null || selected !== undefined ? undefined : index?.pages.find((page) => isAttachment(page) && indexDocumentId(repo, page) === selectedId)
  const indexPage = repo === null || selected?.cloud === undefined ? undefined : index?.pages.find((page) => page.id === selected.cloud!.pageId)
  const graphMode = session.wikiPane === "graph"
  const graphPath = session.wikiGraphPath ?? null
  const fileInput = useRef<HTMLInputElement>(null)
  /*
   * Librarian L5: the link rail and the graph are derived from the same
   * notes the sidebar lists (no effect, no second store). In a space the rail
   * reads the index's backlinks (server-resolved); local notes resolve their
   * own. The graph mode shows every page (the All scope) or one note's
   * neighbourhood.
   */
  const links = useMemo(() => {
    if (graphMode || selected === undefined) return undefined
    if (selected.cloud !== undefined && index !== undefined) return indexLinksOf(index, selected.cloud.pageId) ?? { backlinks: [], linksOut: [], unresolved: [] }
    return linksOf(shown, selected.path)
  }, [graphMode, shown, selected, index])
  const graph = useMemo(() => {
    if (!graphMode) return undefined
    const whole = linkGraphOf(shown)
    return graphPath === null ? whole : neighbourhoodOf(whole, graphPath) ?? whole
  }, [graphMode, shown, graphPath])
  const slug = selected?.cloud?.slug ?? attachment?.slug

  return (
    <section data-keyboard-pane="Wiki" className="world-surface embedded-pane" aria-label={`Smithers ${WIKI_DISPLAY_NAME} state`} data-space={space}>
      <SurfaceHeader
        icon={<BookOpen size={17} aria-hidden="true" />}
        title={WIKI_DISPLAY_NAME}
        closeCommand="chat"
        onClose={() => controller.runCommand("chat")}
      >
        {repo === null ? null : <WikiSpaceSwitch space={space} repo={repo} onRunCommand={controller.runCommand} />}
        {repo === null
          ? <Button variant="ghost" size="sm" {...flowAction(controller.runCommand, "wiki.new-note")}><Plus size={14} aria-hidden="true" />New note</Button>
          : <Button variant="ghost" size="sm" {...flowAction(controller.runCommand, "wiki.cloud.new")}><Plus size={14} aria-hidden="true" />New page</Button>}
        {/* The button door of wiki.graph: the same registry entry the slash and the agent run; it toggles. */}
        <Button
          variant="ghost"
          size="sm"
          {...flowProps("wiki.graph")}
          data-testid="wiki-graph"
          aria-pressed={graphMode}
          onClick={() =>
            // A button always carries its args: a focused graph toggles back from its own focus.
            session.wikiGraphPath ?
              controller.runCommand("wiki.graph", session.wikiGraphPath) :
              controller.runCommand("wiki.graph")}
        >
          <Waypoints size={14} aria-hidden="true" />
          Graph
        </Button>
      </SurfaceHeader>

      <div className="world-workspace" data-pane={graphMode ? "graph" : "document"}>
        <aside
          className="world-sidebar"
          aria-label={`${WIKI_DISPLAY_NAME} pages`}
        >
          <WikiTree scope={scope} documents={shown} selectedId={selectedId} onRunCommand={controller.runCommand} />
        </aside>

        {graph !== undefined ?
          (
            <main
              className="world-graph"
              aria-label={`${WIKI_DISPLAY_NAME} graph`}
              data-testid="wiki-graph-pane"
            >
              <div className="world-document-meta">
                <span data-testid="wiki-pane-graph-scope">
                  {graphPath === null ? WIKI_GRAPH_ALL_SCOPE : `Around ${graphPath}`}
                </span>
              </div>
              <Suspense fallback={<ViewSkeleton />}>
                <KnowledgeGraphSurface
                  notes={graph.notes}
                  links={graph.links}
                  height="100%"
                  onOpenNote={(path) => openIndexPath(scope, shown, controller.runCommand, path)}
                />
              </Suspense>
            </main>
          ) :
        <main className="world-document">
          {attachment !== undefined && repo !== null ?
            (
              <>
                <div className="world-document-meta">
                  <span data-testid="wiki-page-path">{attachment.path}</span>
                  <div>
                    <span className="world-document-revision" data-testid="wiki-page-revision">r{attachment.revision}</span>
                    <Button variant="ghost" size="icon" aria-label={`History of ${attachment.path}`} title="History"
                      {...flowAction(controller.runCommand, "wiki.history", flowArgs("wiki.history", { slug: attachment.slug, repo }))}><History size={13} /></Button>
                    <Button variant="ghost" size="icon" aria-label={`Rename ${attachment.path}`} title="Rename"
                      {...flowAction(controller.runCommand, "wiki.cloud.rename", flowArgs("wiki.cloud.rename", { slug: attachment.slug, path: "", repo }))}><Pencil size={13} /></Button>
                    <Button variant="ghost" size="icon" className="world-delete-btn" aria-label={`Delete ${attachment.path}`} title="Delete"
                      {...flowAction(controller.runCommand, "wiki.cloud.delete", flowArgs("wiki.cloud.delete", { slug: attachment.slug, repo }))}><Trash2 size={13} /></Button>
                  </div>
                </div>
                <div className="world-attachment" data-testid="wiki-attachment">
                  {attachment.attachment !== undefined && /^image\//.test(attachment.attachment.mediaType)
                    ? <img src={attachmentUrl(repo, space, attachment)} alt={attachment.path} />
                    : <a href={attachmentUrl(repo, space, attachment)} download={attachment.path.split("/").pop()} target="_blank" rel="noreferrer">
                      {attachment.path.split("/").pop()} · {attachment.attachment?.mediaType} · {attachment.attachment?.size} B
                    </a>}
                </div>
              </>
            ) :
          selected ?
            (
              <>
                <div className="world-document-meta">
                  <span data-testid="wiki-page-path">{selected.cloud?.path ?? selected.path}</span>
                  <div>
                    {selected.cloud === undefined ? null : <span className="world-document-revision" data-testid="wiki-page-revision">r{selected.cloud.remoteRevision}</span>}
                    {selected.cloud === undefined || repo === null || slug === undefined ? null : <>
                      {/* Attach: the file comes from the human's own dialog; the gesture carries it to wiki.attach. */}
                      <input ref={fileInput} type="file" hidden data-testid="wiki-attach-input" onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ""
                        if (file === undefined) return
                        const gesture = fileGesture("wiki.attach", file)
                        void controller.submitCommand({ name: "wiki.attach", payload: { slug: `${slug}-${file.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`, path: `assets/${file.name}`, repo }, actor: "user", gesture }).finally(gesture.release)
                      }} />
                      <Button variant="ghost" size="icon" aria-label="Attach a file" title="Attach" {...flowProps("wiki.attach")} onClick={() => fileInput.current?.click()}><Paperclip size={13} /></Button>
                      <Button variant="ghost" size="icon" aria-label={`History of ${selected.title}`} title="History" data-testid="wiki-page-history"
                        {...flowAction(controller.runCommand, "wiki.history", flowArgs("wiki.history", { slug, repo }))}><History size={13} /></Button>
                      <Button variant="ghost" size="icon" aria-label={`Rename ${selected.title}`} title="Rename" data-testid="wiki-page-rename"
                        {...flowAction(controller.runCommand, "wiki.cloud.rename", flowArgs("wiki.cloud.rename", { slug, path: "", repo }))}><Pencil size={13} /></Button>
                      <Button variant="ghost" size="icon" className="world-delete-btn" aria-label={`Delete ${selected.title}`} title="Delete" data-testid="wiki-page-delete"
                        {...flowAction(controller.runCommand, "wiki.cloud.delete", flowArgs("wiki.cloud.delete", { slug, repo }))}><Trash2 size={13} /></Button>
                    </>}
                    {selected.cloud !== undefined ? null : <Button
                      variant="ghost"
                      size="icon"
                      className="world-delete-btn"
                      aria-label={`Delete ${selected.title}`}
                      title="Delete note"
                      {...flowAction(controller.runCommand, "wiki.delete", selected.id)}
                    >
                      <Trash2 size={13} />
                    </Button>}
                  </div>
                </div>
                {selected.cloud?.error == null ? null : <p className="world-document-notice" role="status">{selected.cloud.error}</p>}
                {/* Layout only: the editor releases Tab itself (§21.2, `escapeTabOrder`). */}
                <div className="world-editor-region">
                  <Suspense fallback={<ViewSkeleton />}>
                    <MarkdownEditorSurface
                      value={selected.body}
                      resetKey={selected.id}
                      label={`Edit ${selected.title}`}
                      readOnly={selected.cloud !== undefined && (selected.cloud.phase === "cached" || selected.cloud.phase === "deleted")}
                      onChange={(body) => controller.changeWorldDocument(selected.id, body)}
                      /*
                       * Registered twice on purpose: `attachWikiEditor` serves wiki.heading's
                       * scroll; `attachWorldEditor` puts the pane in the map that receives an
                       * accepted remote revision or an agent `remember`, so a keystroke never
                       * writes stale text over a collaborator's.
                       */
                      onEditor={(editor) => {
                        controller.attachWikiEditor(editor)
                        controller.attachWorldEditor(selected.id, "pane", editor)
                      }}
                    />
                  </Suspense>
                </div>
              </>
            ) :
            (
              <EmptyState
                icon={<BookOpen size={20} />}
                title={index !== undefined && index.pages.length === 0 ? `No ${space} ${WIKI_DISPLAY_NAME} pages yet` : `No ${WIKI_DISPLAY_NAME} yet`}
                action={index !== undefined
                  ? <Button {...flowAction(controller.runCommand, "wiki.cloud.new")}>New page</Button>
                  : <Button {...flowAction(controller.runCommand, "wiki.create", activeRepositoryId(controller.store) ?? undefined)}>Create Wiki</Button>}
              />
            )}
        </main>}
        {graph === undefined && selected !== undefined && links !== undefined ?
          (
            <aside
              className="world-rail"
              aria-label={`${selected.title} links and outline`}
              data-testid="wiki-rail"
            >
              <BacklinksPanel
                backlinks={[...links.backlinks]}
                linksOut={[...links.linksOut]}
                onOpenNote={(path) => openIndexPath(scope, shown, controller.runCommand, path)}
                linkProps={(path) => flowProps(indexPage === undefined ? "wiki.open" : "wiki.cloud.open", indexPage === undefined ? path : flowArgs("wiki.cloud.open", { slug: path.replace(/\.md$/i, "").split("/").pop() ?? path, repo: repo!, space }))}
              />
              {links.unresolved.length === 0 ? null : <ul className="wiki-unresolved" aria-label="Unresolved links">
                {links.unresolved.map((target) => <li key={target}>[[{target}]]</li>)}
              </ul>}
              {/* Each heading is the button door of wiki.heading: the editor scrolls to its source line. */}
              <OutlineView
                markdown={selected.body}
                onHeadingClick={(line) => controller.runCommand("wiki.heading", String(line))}
                headingProps={(heading) => flowProps("wiki.heading", String(heading.line))}
              />
            </aside>
          ) :
          null}
      </div>
    </section>
  )
}
