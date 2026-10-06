import { CodeEditorView as Editor, type EditorBinding } from "@smthrs/ui/adapters/code-editor"
import { useMemo, useState } from "react"
import { copyText } from "@smthrs/ui/copy"
import { coEditingVisuals } from "./coEditingVisuals"
import type { CodeEditorViewProps as FileEditorProps } from "@smthrs/rpc/FileCard"
import { ActorChip, actorName } from "./ActorChip"
import { DiffAction } from "./DiffAction"
import { FileX, FileSymlink, FolderSync, History, TriangleAlert, Check } from "lucide-react"
import { formatBytes } from "./formatBytes"

/** File presentation. The card supplies authority; content changes keep the same CodeMirror instance. */
export const CodeEditorView = ({ model, view, actions, gestures, onAction, onView, binding }: FileEditorProps & { readonly binding?: EditorBinding }) => {
  const live = !!binding && model.mode === "live" && model.content.kind === "text" && !model.gone
  const visualBinding = useMemo<EditorBinding | undefined>(() => live && binding ? {
    get text() { return binding.text }, extensions: [binding.extensions, coEditingVisuals(model.authors, model.editors)]
  } : undefined, [live, binding, model.authors, model.editors])
  const [copyFailed, setCopyFailed] = useState(false)
  const buttons = actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)
  const controls = actions.length ? <div className="code-actions">{buttons}</div> : null
  return <section className="smithers-card code-file-view" data-kind="file" data-keyboard-pane="File" data-digest={model.digest || undefined} data-mode={live ? "live" : "read_only"} aria-label={model.path}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.path}</h2><span className="mvp-branch-chip">{model.branch}</span>
      {model.last_writer && !model.gone ? <span className="code-writer" title={actorName(model.last_writer)}><ActorChip actor={model.last_writer} size="s" /></span> : null}
      {live ? <span className="code-live-head"><span className="code-avatar-stack" aria-label={model.editors.map(editor => actorName(editor.actor)).join(", ")}>{model.editors.slice(0, 4).map((editor, i) => <ActorChip key={i} actor={editor.actor} size="s" />)}{model.editors.length > 4 ? <span>+{model.editors.length - 4}</span> : null}</span>{model.saved ? <span className="code-saved" data-saving={model.saved === "saving" || undefined}>{model.saved === "saving" ? "Saving…" : <><Check size={13} aria-hidden="true" />Saved to the machine</>}</span> : null}</span> : null}
      {model.gone ? <span className="code-file-state">{model.gone.kind === "deleted" ? <FileX size={13} aria-hidden="true" /> : <FileSymlink size={13} aria-hidden="true" />}{model.gone.kind === "deleted" ? "Deleted" : "Renamed"}</span> : null}
    </header>
    <div className="smithers-card-body">
      {model.gone ? <>
        <div className="code-file-notice"><TriangleAlert size={14} aria-hidden="true" /><span>{model.gone.kind === "deleted" ? <>Deleted by {actorName(model.gone.by)}</> : <>Renamed to <code title={model.gone.to}>{model.gone.to.split("/").at(-1)}</code> by {actorName(model.gone.by)}</>}</span>{controls}</div>
        <div className="code-snapshot-cap"><History size={12} aria-hidden="true" />Snapshot</div>
      </> : model.outside ? <div className="code-file-notice code-notice" data-tone="outside"><FolderSync size={14} aria-hidden="true" /><span>Changed outside Smithers</span>{!model.unsaved && actions.length ? <span className="code-notice-actions">{buttons}</span> : null}</div> : null}
      {model.unsaved ? <div className="code-notice" data-tone="attention"><span>{model.unsaved.count} {model.unsaved.count === 1 ? "edit wasn't" : "edits weren't"} saved</span><span className="code-notice-actions"><button type="button" onClick={async () => { const result = await copyText(model.unsaved!.text); setCopyFailed(!result.ok) }}>Copy</button>{!model.gone ? buttons : null}</span><pre>{model.unsaved.text}</pre>{copyFailed ? <span role="status">Copy failed</span> : null}</div> : null}
      {!model.gone && !model.outside && !model.unsaved ? controls : null}
      <div className="code-file-editor" data-snapshot={model.gone ? "" : undefined}>
      {model.content.kind !== "text" ? <p className="code-file-size">{model.content.kind === "binary" ? "Binary file" : "Too large to co-edit"} · {formatBytes(model.content.bytes, "decimal")} {model.github_url ? <a href={model.github_url} target="_blank" rel="noreferrer">on GitHub ↗</a> : null}</p> :
        <Editor binding={visualBinding} path={model.path} text={model.content.text} language={model.language}
          diagnostics={model.diagnostics} hover={model.hover} reveal={model.reveal ?? (view.line ? { line: view.line } : undefined)}
          gestures={gestures} onAction={onAction} onView={onView} />}

      </div>
    </div>
  </section>
}
