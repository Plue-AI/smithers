import type { LiveDocProvider } from "../runtime/LiveDocProvider"
import type { EditorBinding } from "@smthrs/ui/adapters/code-editor"
import { LiveFileContext, liveFileModel, type FileDocumentBinding } from "./liveDoc"
import { CodeSurface } from "../ViewModules"
import { cardActions } from "../flows/cardActions"
import { flowAction } from "../flows/FlowAction"
import { fileArgs } from "@smthrs/rpc/FileRead"
/*
 * The repo file cards: a directory listing ("file-list") whose rows open
 * /files.list or /files.read, and a file view ("file") rendered as a fenced
 * code block, honest about truncation. Every row is a command binding through
 * onRunCommand — the one delegated dispatch CardView threads from App.tsx —
 * and carries data-flow with its registered command name.
 */
import { Button } from "@smthrs/ui"
import { FileText, Folder } from "lucide-react"
import { Component, Suspense, useContext } from "react"
import type { ReactNode } from "react"
import { LiveFileMaxBytes } from "@smthrs/rpc/FileCard"
import type { FileCard } from "@smthrs/rpc/FileCard"
import { useLiveQuery } from "@tanstack/react-db"
import type { Card } from "../state/AppState"
import { shortId } from "../state/ids"
import type { AppController } from "../state/AppController"
import { ControllerContext } from "../ControllerContext"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/*
 * A lazy viewer whose chunk fails to load (an old tab after a deploy, or the
 * dev server re-optimizing its dependencies) falls back to the plain view its
 * loading state already shows: the file stays readable, and the failure stays
 * inside this card.
 */
class LazyViewerBoundary extends Component<{ readonly fallback: ReactNode; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state: { readonly failed: boolean } = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export interface FileCardActions {
  readonly onRunCommand: RunCommand
}

/** The listing's host determines both preloading and activation. */
type FileListNavigation = {
  readonly scope: string
} & (
  | { readonly list: "files.list"; readonly read: "files.read" }
  | { readonly list: "box.files"; readonly read: "box.file" }
)

/** The entry's full path under the card's path — the argument the row's command takes. */
const childPath = (parent: string, name: string): string => parent === "" ? name : `${parent}/${name}`

/*
 * The card's address header (lane piper step 5, ADR 0001): the global path
 * `/org/repo/path` the payload carries, plus the position the read was taken
 * at, plus — when the inventory says the repository's head has moved since —
 * a "head moved to <id> · refresh" line. Nothing auto-refreshes: the card
 * states where it stands; the human (or the model) re-reads explicitly.
 * The controller is read from context directly so component tests without a
 * provider still render the plain address.
 */
const FileCardHeader = (props: {
  readonly repo: string
  readonly localRepoId?: string | undefined
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source?: "head" | "working-copy" | undefined } | undefined
  readonly refreshCommand: "files.read" | FileListNavigation["list"]
  readonly refreshScope?: string | undefined
  readonly onRunCommand: RunCommand
  readonly trailing?: ReactNode
}) => {
  const controller = useContext(ControllerContext)
  if (controller === null) return <FileCardAddressLine {...props} head={null} />
  return <FileCardHeaderLive {...props} controller={controller} />
}

export const FileCardAddressLine = ({
  repo,
  localRepoId,
  path,
  address,
  readAt,
  head,
  refreshCommand,
  refreshScope,
  onRunCommand,
  trailing
}: {
  readonly repo: string
  readonly localRepoId?: string | undefined
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source?: "head" | "working-copy" | undefined } | undefined
  readonly head: { readonly changeId: string | null; readonly commitId: string | null } | null
  readonly refreshCommand: "files.read" | FileListNavigation["list"]
  readonly refreshScope?: string | undefined
  readonly onRunCommand: RunCommand
  /** Rendered at the end of the address line: the file card's language word. */
  readonly trailing?: ReactNode
}) => {
  // A working-copy read is pinned at the checkout's `@`, which is not the head by design: its drift is the origin chip's "N ahead", never "head moved".
  const moved = readAt?.source !== "working-copy" && head !== null && readAt?.commitId != null && head.commitId != null &&
    head.commitId !== readAt.commitId
  const refreshArgs = fileArgs(path === "" ? "/" : path, refreshScope ?? localRepoId ?? repo)
  return (
    <div>
      <p className="world-card-path">
        {address ?? `${repo} · ${path || "/"}`}
        {readAt?.changeId != null ? ` · ${shortId(readAt.changeId)}` : null}
        {trailing == null ? null : <span className="world-card-path-trailing">{trailing}</span>}
      </p>
      {moved ?
        (
          <p className="world-card-empty">
            head moved to {shortId(head.changeId ?? head.commitId ?? "")}
            {" · "}
            <Button
              variant="ghost"
              size="sm"
              {...flowAction(onRunCommand, refreshCommand, refreshArgs)}
            >
              refresh
            </Button>
          </p>
        ) :
        null}
    </div>
  )
}

const FileCardHeaderLive = ({
  controller,
  ...props
}: {
  readonly controller: AppController
  readonly repo: string
  readonly localRepoId?: string | undefined
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source?: "head" | "working-copy" | undefined } | undefined
  readonly refreshCommand: "files.read" | FileListNavigation["list"]
  readonly refreshScope?: string | undefined
  readonly onRunCommand: RunCommand
  readonly trailing?: ReactNode
}) => {
  const { data: repositoryRows } = useLiveQuery((q) =>
    q.from({ repository: controller.store.collections.repositories }).select(({ repository }) => ({
      id: repository.id,
      head: repository.head
    })))
  const head = repositoryRows.find((row) => row.id === props.repo)?.head ?? null
  return <FileCardAddressLine {...props} head={head} />
}

export const FileListCardBody = ({
  card,
  navigation,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "file-list" }>
  readonly navigation?: FileListNavigation
} & FileCardActions) => {
  const { repo, path, entries } = card.payload
  const { list, read, scope } = navigation ?? { list: "files.list", read: "files.read", scope: card.payload.localRepoId ?? repo }
  return (
    <div className="world-card-list world-card-panel">
      <FileCardHeader
        repo={repo}
        localRepoId={card.payload.localRepoId}
        path={path}
        address={card.payload.address}
        readAt={card.payload.readAt}
        refreshCommand={list}
        refreshScope={scope}
        onRunCommand={onRunCommand}
      />
      <ul className="world-card-list">
        {entries.length === 0 ?
          (
            <li className="world-card-empty">
              Nothing under {path || "/"} in {repo}.
            </li>
          ) :
          (
            entries.map((entry) => (
              <li key={entry.name} className="world-card-row">
                {entry.kind === "dir" ?
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      {...flowAction(onRunCommand, list, fileArgs(childPath(path, entry.name), scope))}
                    >
                      <Folder size={12} aria-hidden="true" />
                      <span className="world-card-title">{entry.name}</span>
                    </Button>
                  ) :
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      {...flowAction(onRunCommand, read, fileArgs(childPath(path, entry.name), scope))}
                    >
                      <FileText size={12} aria-hidden="true" />
                      <span className="world-card-title">{entry.name}</span>
                    </Button>
                  )}
              </li>
            ))
          )}
      </ul>
      {card.payload.truncated === true ?
        <p className="world-card-empty">Truncated — the directory holds more entries than the listing shows.</p> :
        null}
    </div>
  )
}

/** Legacy journal data maps to S1 props without granting execution authority. */
export const fileModel = (payload: Extract<Card, { kind: "file" }>["payload"]): FileCard => {
  const bytes = new TextEncoder().encode(payload.content).length
  return {
    path: payload.path, branch: payload.ref ?? payload.repo, language: "", digest: "",
    content: bytes > LiveFileMaxBytes
      ? { kind: "too_large", bytes, text: payload.content }
      : { kind: "text", text: payload.content }, mode: "read_only",
    diagnostics: (payload.diagnostics ?? []).flatMap(item => item.severity === "error" || item.severity === "warning"
      ? [{ line: item.line, col: item.character - 1, severity: item.severity, message: item.message }] : []),
    ...(payload.hover == null ? {} : { hover: { line: payload.hover.line, col: payload.hover.character - 1, markdown: payload.hover.contents } }),
    ...(payload.line === undefined ? {} : { reveal: { line: payload.line, ...(payload.column === undefined ? {} : { col: payload.column - 1 }) } }),
    authors: [], editors: []
  }
}

export const FileCardBody = ({ card, live, onRunCommand }: { readonly card: Extract<Card, { kind: "file" }>; readonly live?: { readonly provider: LiveDocProvider; readonly binding: EditorBinding } } & FileCardActions) => {
  const payload = card.payload
  const documents = useContext(LiveFileContext)
  const document = live ?? documents?.resolve(payload.ref ?? payload.repo, payload.path)
  // Old binary cards carry no byte count. Do not invent one.
  if (payload.binary) return <p className="code-file-size">Binary file</p>
  if (document) return <LiveFileBody card={card} document={document} onRunCommand={onRunCommand} />
  return <FileContent card={card} model={fileModel(payload)} onRunCommand={onRunCommand} />
}

const LiveFileBody = ({ card, document, onRunCommand }: { card: Extract<Card, { kind: "file" }>; document: FileDocumentBinding } & FileCardActions) => {
  const { data: status } = useLiveQuery(q => q.from({ document: document.provider.collection }))
  const model = liveFileModel(fileModel(card.payload), document.provider, document.provider.awareness.getStates())
  return <FileContent card={card} model={model} onRunCommand={onRunCommand} binding={status[0]?.editable && model.mode === "live" ? document.binding : undefined} />
}

/** Catalog absence keeps execution dark; persisted answers never grant a gesture. */
export const fileIntelligenceActions = (
  payload: Extract<Card, { kind: "file" }>["payload"],
  onRunCommand: RunCommand,
  available: (tag: "code.hover" | "code.definition") => boolean
) => cardActions<"hover" | "definition">((tag, input) => {
  if (tag !== "code.hover" && tag !== "code.definition") return
  const position = input as { path: string; line: number; col: number }
  flowAction(onRunCommand, tag, fileArgs(`${position.path}:${position.line}:${position.col + 1}`, payload.localRepoId ?? payload.repo)).onClick()
}, (["hover", "definition"] as const).flatMap(gesture => {
  const tag = gesture === "hover" ? "code.hover" as const : "code.definition" as const
  return available(tag) ? [{ tag, label: "", gesture,
    command_input: { path: payload.path, line: payload.line ?? 1, col: (payload.column ?? 1) - 1 },
    resolve_input: (input: Record<string, string>) => ({ path: payload.path, line: Number(input.line), col: Number(input.col) })
  }] : []
}))

const FileContent = ({ card, model, binding, onRunCommand }: { card: Extract<Card, { kind: "file" }>; model: FileCard; binding?: EditorBinding | undefined } & FileCardActions) => {
  const payload = card.payload
  const controller = useContext(ControllerContext)
  const bindings = fileIntelligenceActions(payload, onRunCommand, tag => controller?.commands.find(tag) !== undefined)
  return <div className="world-card-panel" data-line={payload.line}>
    <LazyViewerBoundary fallback={<pre className="world-card-path">{payload.content}</pre>}>
      <Suspense fallback={<pre className="world-card-path">{payload.content}</pre>}>
        <CodeSurface binding={binding} model={model} view={{ maximized: false }} {...bindings} onView={() => {}} />
      </Suspense>
    </LazyViewerBoundary>
    {payload.truncated ? <p className="world-card-empty">Truncated</p> : null}
  </div>
}

export const fileCardFamily: CardFamily<"file-list" | "file"> = {
  "file-list": {
    render: (card, actions) => <FileListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  file: {
    render: (card, actions) => <FileCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
