import { ViewSkeleton } from "../ViewSkeleton"
import { MarkdownEditorSurface } from "../ViewModules"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction, flowProps } from "../flows/FlowAction"
import { Badge, Button, FileTree } from "@smthrs/ui"
import { ExternalLink, GitPullRequest, Hash, ListChecks, Server } from "lucide-react"
import { ageLabel } from "../Timestamps"
import { Suspense, useId, useContext, useSyncExternalStore, type ReactNode } from "react"
import { parseOutline } from "@smthrs/ui/vault"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import type { Card, WorldDocument } from "../state/AppState"
import { WIKI_DISPLAY_NAME } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { ControllerContext } from "../ControllerContext"
import { activeRepositoryId } from "../state/RepoContext"
import { settledPill } from "./CardFamily"
import { WikiTree, useWikiScope } from "../wiki/WikiNavigation"
import { pageLinksOf, WikiPageView } from "../wiki/WikiPageView"
import { cloudWikiPageFailure } from "../wiki/CloudWikiFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { IntegrationRow } from "@smthrs/rpc/Threads"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"



/*
 * The connect surface as an embedded card (§2c″ — the agent's connect form):
 * the same extension-store grammar as the pane, derived from the session the
 * card was rendered with. Sign-in and the GitHub connector are one act
 * (§2a′): a signed-in session reads Connected, never "connect again".
 */
export const ConnectCardBody = ({
  card,
  onConnectGitHub,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "connect" }>
  readonly onConnectGitHub: () => void
  readonly onRunCommand: RunCommand
}) => (
  <ul className="connect-store-list">
    {card.payload.provider === "github" ? <li className="connect-store-row">
      <span className="connect-store-icon">
        <GitPullRequest size={16} aria-hidden="true" />
      </span>
      <span className="connect-store-text">
        <strong>GitHub</strong>
      </span>
      {card.payload.github.connected ?
        <Badge variant="success">Connected ✓ as {card.payload.github.login ?? "you"}</Badge> :
        (
          <Button size="sm" {...flowProps("auth.sign-in")} onClick={() => onConnectGitHub()}>
            Connect
          </Button>
        )}
    </li> : null}
    <li className="connect-store-row">
      <span className="connect-store-icon">
        <Server size={16} aria-hidden="true" />
      </span>
      <span className="connect-store-text">
        <strong>Smithers Cloud repository</strong>
      </span>
      <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "repos.import")}>
        Import
      </Button>
    </li>
    {/* Integrations (smithers-ui-DESIGN.md §3.6): Slack for conversations and Linear for issues, read from the registered routes by integrations.list. */}
    {card.payload.integrations?.rows.map((row) => (
      <li key={row.id} className="connect-store-row" data-integration={row.id} data-state={row.state}>
        <span className="connect-store-icon">
          {row.id === "slack" ? <Hash size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}
        </span>
        <span className="connect-store-text">
          <strong>{INTEGRATION_NAMES[row.id]}</strong>
          <span className="connect-store-detail">
            {INTEGRATION_SYNCS[row.id]}{row.detail === undefined ? "" : <> ↔ <code>{row.detail}</code></>}
            {row.lastSyncAt === undefined ? null : <> · synced {ageLabel(row.lastSyncAt)}</>}
          </span>
          {row.error === undefined ? null : <FailureNotice className="connect-store-error" data-testid={`integration-failure-${row.id}`}
            failure={describedFailure(`IntegrationFailed.${row.id}`, INTEGRATION_FAILURES[row.id], row.error)}
            actions={{ retry: flowAction(onRunCommand, "integrations.list", flowArgs("integrations.list", { repo: card.payload.integrations!.repo })) }} />}
        </span>
        {row.id === "slack" && row.state === "not-connected" ? <Button size="sm" {...flowAction(onRunCommand, "integrations.admit", flowArgs("integrations.admit", { repo: card.payload.integrations!.repo }))}>Connect</Button>
          : row.state === "connected" ? <Badge variant="success">Connected ✓</Badge>
          : row.state === "unavailable" ? <Badge variant="outline">Unavailable</Badge>
          : row.state === "error" ? <Badge variant="destructive">Error</Badge>
          : null}
      </li>
    ))}
  </ul>
)

const INTEGRATION_NAMES = { slack: "Slack", linear: "Linear" } as const
const INTEGRATION_SYNCS = { slack: "conversations", linear: "issues" } as const
/** A row in `error` names its service; the server's words (or a Linear remediation code) are only its Details. */
export const INTEGRATION_FAILURES: Readonly<Record<IntegrationRow["id"], UserFailureCopy>> = {
  slack: { fault: "infra", sentence: "Smithers can't sync Slack right now. Not your fault.", actions: ["retry"] },
  linear: { fault: "infra", sentence: "Smithers can't sync Linear right now. Not your fault.", actions: ["retry"] }
}
/** A browser card's error is a refusal whose type did not survive; the page's words are only its Details. */
export const BROWSER_READ_FAILURE: UserFailureCopy = { fault: "infra", sentence: "That page couldn't be read. Not your fault.", actions: [] }

/*
 * The world query's embedded answer card (§2c″) — the answer rides in the chat
 * text beside it. The card is a browsable slice of the world: the surfaced
 * documents as a file tree, the selected one open in the markdown editor.
 * Bodies come from the LIVE worldDocuments collection (the payload is a
 * path/title/confidence snapshot), so a note deleted since the query gets an
 * honest note instead of stale text.
 */
export const WorldCardBody = ({
  card,
  worldDocuments,
  onChangeWorldDocument,
  onAttachWorldEditor,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "world" }>
  readonly worldDocuments: ReadonlyArray<WorldDocument>
  readonly onChangeWorldDocument: (id: string, body: string) => void
  readonly onAttachWorldEditor?: (id: string, slot: string, editor: MarkdownEditorHandle | null) => void
  readonly onRunCommand: RunCommand
}) => {
  const editorSlot = useId()
  const controller = useContext(ControllerContext)
  if (card.payload.documents.length === 0) {
    return <div className="world-card-empty"><p>{card.payload.index && card.payload.index.page > 1 ? "No Wiki pages in this view." : "No Wiki yet."}</p>{card.payload.index !== undefined && card.payload.index.page > 1 ?
      <Button size="sm"  {...flowAction(onRunCommand, "wiki.cloud", flowArgs("wiki.cloud", { repo: card.payload.index!.repo, page: card.payload.index!.page - 1, space: card.payload.index!.space ?? "public" }))}>Previous page</Button> :
      <Button size="sm"  {...flowAction(onRunCommand, "wiki.create", card.payload.index?.repo ?? (controller ? activeRepositoryId(controller.store) ?? undefined : undefined))}>Create Wiki</Button>}</div>
  }
  const documents = card.payload.documents.map((entry) => ({ entry, document: worldDocuments.find((document) =>
    entry.id === undefined ? document.path === entry.path : document.id === entry.id) }))
  const selected = documents.find(({ entry, document }) => (document?.id ?? entry.id) === card.payload.selectedDocumentId) ?? documents[0]!
  const { entry, document } = selected
  const treePath = ({ entry, document }: typeof selected) => document?.cloud?.slug ?? entry.cloud?.slug ?? document?.path ?? entry.path
  const view = card.payload.view ?? "outline"
  const cloud = document?.cloud
  const readOnly = cloud !== undefined && (cloud.phase === "cached" || cloud.phase === "deleted")
  const pageFailure = cloud === undefined ? null : cloudWikiPageFailure(cloud)
  return (
    <div className="world-card-workspace">
      <aside className="world-card-sidebar" aria-label={`${WIKI_DISPLAY_NAME} documents`}>
        {card.payload.index === undefined ? null : <span className="wiki-space-chip" data-space={card.payload.index.space ?? "public"} data-testid="wiki-card-space">{card.payload.index.space ?? "public"}</span>}
        {/* An index card lists its space's tree (folders, pages, search, tags) once the index is read; before that, the listing's rows. */}
        {card.payload.index !== undefined && controller !== null
          ? <WikiCardTree space={card.payload.index.space ?? "public"} documents={worldDocuments} selectedId={document?.id} onRunCommand={onRunCommand}
            fallback={<FileTree
              nodes={documents.map((row) => ({ path: treePath(row), label: row.document?.title ?? row.entry.title }))}
              selected={treePath(selected)}
              onSelect={(path) => {
                const row = documents.find((candidate) => treePath(candidate) === path)
                if (row !== undefined) onRunCommand("wiki.card.select", flowArgs("wiki.card.select", { cardId: card.id, documentId: row.document?.id ?? row.entry.id ?? row.entry.path }))
              }} />} />
          : <FileTree
            nodes={documents.map((row) => ({ path: treePath(row), label: row.document?.title ?? row.entry.title }))}
            selected={treePath(selected)}
            onSelect={(path) => {
              const row = documents.find((candidate) => treePath(candidate) === path)
              if (row !== undefined) onRunCommand("wiki.card.select", flowArgs("wiki.card.select", { cardId: card.id, documentId: row.document?.id ?? row.entry.id ?? row.entry.path }))
            }} />}
        {card.payload.index === undefined ? null : <div className="wiki-card-pages">
          {card.payload.index.page <= 1 ? null : <Button size="sm" variant="ghost"  {...flowAction(onRunCommand, "wiki.cloud", flowArgs("wiki.cloud", { repo: card.payload.index!.repo, page: card.payload.index!.page - 1, space: card.payload.index!.space ?? "public" }))}>Previous page</Button>}
          {card.payload.index.hasNext ? <Button size="sm" variant="ghost"  {...flowAction(onRunCommand, "wiki.cloud", flowArgs("wiki.cloud", { repo: card.payload.index!.repo, page: card.payload.index!.page + 1, space: card.payload.index!.space ?? "public" }))}>Next page</Button> : null}
        </div>}
      </aside>
      <div className="world-card-doc">
        <div className="world-card-meta">
          <span className="world-card-path">{document?.path ?? entry.path}</span>
          <div className="wiki-card-views" aria-label="Wiki view">
            {(cloud === undefined ? ["outline", "document"] as const : ["outline", "read", "document"] as const).map((mode) => <Button key={mode} size="sm" variant="ghost"
              aria-pressed={view === mode} 
              {...flowAction(onRunCommand, "wiki.card.view", flowArgs("wiki.card.view", { cardId: card.id, view: mode }))}>
              {mode === "outline" ? "Outline" : mode === "document" && cloud !== undefined ? "Edit" : "Document"}
            </Button>)}
          </div>
        </div>
        {document === undefined ? entry.cloud === undefined ? <p className="world-card-empty">This note is no longer available in {WIKI_DISPLAY_NAME}.</p> :
          <div className="wiki-card-outline"><h3>{entry.title}</h3><p>Page revision {entry.cloud.revision}</p>
            <Button size="sm"  {...flowAction(onRunCommand, "wiki.cloud.open", flowArgs("wiki.cloud.open", { slug: entry.cloud!.slug, repo: entry.cloud!.repo }))}>Open page</Button>
          </div> : <>
          {cloud === undefined ? null : <div className="wiki-card-source">
            <span>Page revision {cloud.remoteRevision} · {cloud.remoteAuthor}</span>
            <span>{cloud.pending.length === 0 ? "No pending edits" : `${cloud.pending.length} pending edit${cloud.pending.length === 1 ? "" : "s"}`}</span>
            {cloud.phase === "deleted" ? null : <Button size="sm" variant="ghost" 
              {...flowAction(onRunCommand, "wiki.sync", document.id)}>Refresh</Button>}
            <Button size="sm" variant="ghost" data-testid="wiki-card-history"
              {...flowAction(onRunCommand, "wiki.history", flowArgs("wiki.history", { slug: cloud.slug, repo: cloud.repo }))}>History</Button>
            {cloud.phase === "cached" ? <p>This is a saved copy. Refresh to resume collaboration.</p> : null}
            {pageFailure === null ? null : <FailureNotice failure={pageFailure} role="status" data-testid="wiki-card-failure" />}
          </div>}
          {view === "outline" ? <div className="wiki-card-outline">
            <h3>{document.title}</h3>
            <ol aria-label="Page outline">{parseOutline(document.body).map((heading) =>
              <li key={heading.line} data-depth={heading.depth}><button type="button" {...flowAction(onRunCommand, "wiki.heading", flowArgs("wiki.heading", { line: String(heading.line), cardId: card.id }))}>{heading.text}</button></li>)}</ol>
            <details><summary>Sources</summary><ul>{document.sources.map((source) => <li key={source}>{source}</li>)}</ul>
              {cloud === undefined ? <p>Saved by {document.updatedBy} at app revision {document.revision}.</p> :
                <p>Page {cloud.pageId} in {cloud.repo}. Recorded at {cloud.remoteUpdatedAt}.</p>}
            </details>
          </div> : view === "read" && cloud !== undefined ? <WikiCardPage document={document} onRunCommand={onRunCommand} /> : <Suspense fallback={<ViewSkeleton />}>
            <MarkdownEditorSurface
              value={document.body}
              resetKey={document.id}
              label={`${readOnly ? "Read" : "Edit"} ${document.title}`}
              readOnly={readOnly}
              onChange={(body) => onChangeWorldDocument(document.id, body)}
              onEditor={(editor) => onAttachWorldEditor?.(document.id, `${card.id}:${editorSlot}`, editor)}
            />
          </Suspense>}
        </>}
      </div>
    </div>
  )
}

/** The card and pane render the same published Markdown and source links. */
const WikiCardPage = ({ document, onRunCommand }: { readonly document: WorldDocument; readonly onRunCommand: RunCommand }) => {
  const controller = useContext(ControllerContext)
  const cloud = document.cloud!, space = cloud.visibility ?? "public"
  const indexes = controller?.wikiIndexes
  const index = useSyncExternalStore(indexes?.subscribe ?? noWikiSubscription,
    () => indexes?.get(cloud.repo, space), () => indexes?.get(cloud.repo, space))
  return <WikiPageView body={document.body} links={pageLinksOf(index, cloud.pageId)} index={index}
    repo={cloud.repo} space={space} onRunCommand={onRunCommand} onOpen={(path) => {
      const page = index?.pages.find((page) => page.path === path)
      if (page !== undefined) onRunCommand("wiki.cloud.open", flowArgs("wiki.cloud.open", { slug: page.slug, repo: cloud.repo, space }))
    }} />
}

const noWikiSubscription = () => () => {}

/** The index card's tree: the space's navigation index when it is read, else the listing the card carries. */
const WikiCardTree = ({ space, documents, selectedId, onRunCommand, fallback }: {
  readonly space: "public" | "private"
  readonly documents: ReadonlyArray<WorldDocument>
  readonly selectedId: string | undefined
  readonly onRunCommand: RunCommand
  readonly fallback: ReactNode
}) => {
  const scope = useWikiScope(space)
  return scope.index === undefined ? <>{fallback}</> : <WikiTree scope={scope} documents={documents} selectedId={selectedId} onRunCommand={onRunCommand} testId="wiki-card-tree" />
}

/*
 * The browser surface (§2d′): the page embedded in an iframe with its URL
 * visible; a site that refuses framing gets the honest state + the one next
 * step, never a silent blank.
 */
/**
 * The URL a browser card may embed or link: absolute http(s) only, and never
 * the app's own origin. A card can arrive from an upstream chat frame, and a
 * same-origin frame sandboxed with allow-scripts + allow-same-origin can
 * script the app document that holds the local session.
 */
const foreignHttpUrl = (url: string): URL | undefined => {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) && parsed.origin !== window.location.origin ? parsed : undefined
  } catch { return undefined }
}

export const BrowserCardBody = ({ card }: { readonly card: Extract<Card, { kind: "browser" }> }) => {
  const { url, finalUrl, frameable, blockReason, error } = card.payload
  const shownUrl = finalUrl ?? url
  const target = foreignHttpUrl(shownUrl)
  if (error !== undefined) {
    return (
      <FailureNotice className="sui-approval-error" data-testid="browser-card-failure"
        failure={describedFailure("BrowserReadFailed", BROWSER_READ_FAILURE, error)} />
    )
  }
  return (
    <div className="browser-card">
      {/* NO INVENTION: §2d′ asks for the frame with the URL visible — nothing else. */}
      <p className="browser-card-url">
        <ExternalLink size={12} aria-hidden="true" /> {shownUrl}
      </p>
      {frameable && target !== undefined ?
        (
          /*
           * §8.13: the app document is cross-origin isolated (COEP
           * require-corp) because OPFS needs it, and under that policy Chrome
           * blocks every cross-origin frame whose response carries no CORP
           * header — which is practically every site on the public web. The
           * frame went to chrome-error:// and the card rendered an empty white
           * box while its pill still read DONE. A credentialless frame is the
           * escape hatch the policy ships with: it loads third-party documents
           * without credentials and without demanding CORP of them, and the
           * document stays isolated.
           */
          <iframe
            className="browser-card-frame"
            src={target.href}
            title={shownUrl}
            // @ts-expect-error React has no typing for the credentialless attribute yet.
            credentialless=""
            sandbox="allow-scripts allow-same-origin"
            /* Control focus: a cross-origin frame is detected as window blur + activeElement === this iframe. */
            data-control-focus-id={`browser:${card.id}`}
            data-control-focus-kind="browser"
          />
        ) :
        (
          <div className="browser-card-blocked">
            <p>{blockReason ?? "This site can't be embedded here."}</p>
            {target !== undefined && <a className="browser-card-open" href={target.href} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>}
          </div>
        )}
    </div>
  )
}


/* These cards exist once their read has settled, so they wear "done" (§28.3). */
export const conversationCardFamily: CardFamily<"connect" | "world" | "browser"> = {
  connect: {
    render: (card, actions) => (
      <ConnectCardBody
        card={card}
        onConnectGitHub={actions.onConnectGitHub}
        onRunCommand={actions.onRunCommand}
      />
    ),
    pill: settledPill
  },
  world: {
    render: (card, actions) => (
      <WorldCardBody
        card={card}
        worldDocuments={actions.worldDocuments}
        onChangeWorldDocument={actions.onChangeWorldDocument}
        onAttachWorldEditor={actions.onAttachWorldEditor}
        onRunCommand={actions.onRunCommand}
      />
    ),
    pill: settledPill
  },
  browser: { render: (card) => <BrowserCardBody card={card} />, pill: settledPill }
}
