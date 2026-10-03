import { useMemo, useRef } from "react"
import { Markdown } from "@smthrs/ui/markdown"
import { CodeFileView } from "@smthrs/ui/adapters/code-view"
import type { CodeLineAnnotation, CodeTokenPosition } from "@smthrs/ui/adapters/code-view"
import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import { ActorChip, actorName } from "./views/ActorChip"
import { DiffAction } from "./views/DiffAction"
import { FileX, FileSymlink, FolderSync, History, TriangleAlert } from "lucide-react"
import { formatBytes } from "./views/formatBytes"

/** S1 File presentation. The card supplies authority; content changes keep the same CodeFileView instance. */
export const CodeSurface = ({ model, view, actions, gestures, onAction }: CodeEditorViewProps) => {
  const asked = useRef<{ key: string; text: string } | null>(null)
  const annotations = useMemo<readonly CodeLineAnnotation[]>(() => [
    ...model.diagnostics.map((item, index) => ({ key: `diagnostic-${index}`, line: item.line,
      node: <p className="code-diagnostic" data-slot="code-diagnostic" data-severity={item.severity}>{item.message}</p> })),
    ...(model.hover ? [{ key: "hover", line: model.hover.line,
      node: <div className="code-hover"><Markdown className="code-hover-body" content={model.hover.markdown} /></div> }] : [])
  ], [model.diagnostics, model.hover])
  const position = (token: CodeTokenPosition) => ({ path: model.path, line: String(token.line), col: String(token.column - 1) })
  const hover = (token: CodeTokenPosition) => {
    const key = `${model.path}:${model.digest}:${token.line}:${token.column}`
    const text = model.content.kind === "text" ? model.content.text : ""
    if ((asked.current?.key === key && asked.current.text === text) || (model.hover?.line === token.line && model.hover.col === token.column - 1)) return
    asked.current = { key, text }
    if (gestures.hover) onAction(gestures.hover.tag, position(token))
  }
  const definition = (token: CodeTokenPosition) => {
    if (gestures.definition) onAction(gestures.definition.tag, position(token))
  }
  const controls = actions.length ? <div className="code-actions">{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</div> : null
  return <section className="smithers-card code-file-view" data-kind="file" data-keyboard-pane="File" data-digest={model.digest || undefined} data-mode="read_only" aria-label={model.path}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.path}</h2><span className="mvp-branch-chip">{model.branch}</span>
      {model.last_writer && !model.gone ? <span className="code-writer" title={actorName(model.last_writer)}><ActorChip actor={model.last_writer} size="s" /></span> : null}
      {model.gone ? <span className="code-file-state">{model.gone.kind === "deleted" ? <FileX size={13} aria-hidden="true" /> : <FileSymlink size={13} aria-hidden="true" />}{model.gone.kind === "deleted" ? "Deleted" : "Renamed"}</span> : null}
    </header>
    <div className="smithers-card-body">
      {model.gone ? <>
        <div className="code-file-notice"><TriangleAlert size={14} aria-hidden="true" /><span>{model.gone.kind === "deleted" ? <>Deleted by {actorName(model.gone.by)}</> : <>Renamed to <code title={model.gone.to}>{model.gone.to.split("/").at(-1)}</code> by {actorName(model.gone.by)}</>}</span>{controls}</div>
        <div className="code-snapshot-cap"><History size={12} aria-hidden="true" />Snapshot</div>
      </> : model.outside ? <div className="code-file-notice" data-tone="outside"><FolderSync size={14} aria-hidden="true" /><span>Changed outside Smithers</span>{controls}</div> : null}
      {!model.gone && !model.outside ? controls : null}
      <div className="code-file-editor" data-snapshot={model.gone ? "" : undefined}>
      {model.content.kind !== "text" ? <p className="code-file-size">{model.content.kind === "binary" ? "Binary file" : "Too large to co-edit"} · {formatBytes(model.content.bytes, "decimal")} {model.github_url ? <a href={model.github_url} target="_blank" rel="noreferrer">on GitHub ↗</a> : null}</p> :
        <div className="code-surface" tabIndex={0} role="region" aria-label="File content"
          data-flow={gestures.hover?.tag} data-flow-activate={gestures.definition?.tag}
          onKeyDown={event => {
            if (!((event.key === "F12" && gestures.definition) || (event.key === "F10" && event.shiftKey && gestures.hover))) return
            // Selection remains untouched. Prefer its token, otherwise the supplied reveal position.
            const selection = window.getSelection()
            const element = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement
            const token = element?.closest<HTMLElement>("[data-char]")
            const row = token?.closest<HTMLElement>("[data-line]")
            const surface = event.currentTarget.querySelector("diffs-container")
            const selected = token?.getRootNode() === surface?.shadowRoot
            const at = { line: selected ? Number(row?.dataset.line) : model.reveal?.line ?? view.line ?? 1,
              column: selected ? Number(token?.dataset.char) + 1 : (model.reveal?.col ?? 0) + 1, text: "" }
            if (!Number.isInteger(at.line) || at.line < 1 || !Number.isInteger(at.column) || at.column < 1) return
            event.preventDefault()
            if (event.key === "F12") definition(at)
            else hover(at)
          }}>
          <CodeFileView name={model.path} contents={model.content.text} line={model.reveal?.line ?? view.line}
            annotations={annotations} onTokenRest={gestures.hover ? hover : undefined} onTokenActivate={gestures.definition ? definition : undefined} />
        </div>}
      </div>
    </div>
  </section>
}
