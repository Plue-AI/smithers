import type { EditorBinding } from "@smthrs/ui/adapters/code-editor"
import { useMemo, useState, type ReactNode } from "react"
import { copyText } from "@smthrs/ui/copy"
import { coEditingVisuals } from "./coEditingVisuals"
import type { CodeEditorViewProps as FileEditorProps } from "@smthrs/rpc/FileCard"
import { ActorChip, actorName } from "./ActorChip"
import { DiffAction } from "./DiffAction"
import { FileX, FileSymlink, FolderSync, History, TriangleAlert, Check } from "lucide-react"
import { formatBytes } from "./formatBytes"

/** App-only snapshot bytes; the container loads and binds the named revision. */
export type FileComparison = { readonly version: string; readonly text: string }
/** One editor the View places: the current text (live when `binding` is set) or the compared snapshot. */
export type FileEditorSlot = { readonly kind: "current"; readonly text: string; readonly binding?: EditorBinding } | { readonly kind: "snapshot"; readonly text: string }
/**
 * `editor` draws a slot with the CodeMirror adapter and its gesture seams; CodeEditorSurface
 * supplies it, so this View stays props-only (C-UI-08) and never imports the adapter.
 */
export type CodeEditorViewProps = FileEditorProps & { readonly binding?: EditorBinding; readonly comparison?: FileComparison; readonly onCopy?: () => Promise<boolean>; readonly header?: ReactNode; readonly editor: (slot: FileEditorSlot) => ReactNode }

/** File presentation. The card supplies authority; content changes keep the same CodeMirror instance. */
export const CodeEditorView = ({ model, view, actions, onAction, binding, comparison, onCopy, header, editor }: CodeEditorViewProps) => {
  const comparing = !!view.compare && !model.gone && model.content.kind === "text" && ((!!model.outside && comparison?.version === model.outside.version) || (!!model.unsaved && comparison?.version === "unsaved"))
  const live = !comparing && !!binding && model.mode === "live" && model.content.kind === "text" && !model.gone
  const visualBinding = useMemo<EditorBinding | undefined>(() => live && binding ? {
    identity: binding, get text() { return binding.text }, extensions: [binding.extensions, coEditingVisuals(model.authors, model.editors)]
  } : undefined, [live, binding, model.authors, model.editors])
  const [copyFailed, setCopyFailed] = useState(false)
  const buttons = actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)
  const controls = actions.length ? <div className="code-actions">{buttons}</div> : null
  return <section className="smithers-card code-file-view" data-kind="file" data-keyboard-pane="File" data-digest={model.digest || undefined} data-mode={live ? "live" : "read_only"} aria-label={model.path}>
    {header === undefined ? <header className="smithers-card-header"><h2 className="smithers-card-title">{model.path}</h2><span className="mvp-branch-chip">{model.branch}</span>
      {model.last_writer && !model.gone ? <span className="code-writer" title={actorName(model.last_writer)}><ActorChip actor={model.last_writer} size="s" /></span> : null}
      {live ? <span className="code-live-head"><span className="code-avatar-stack" aria-label={model.editors.map(editor => actorName(editor.actor)).join(", ")}>{model.editors.slice(0, 4).map((editor, i) => <ActorChip key={i} actor={editor.actor} size="s" />)}{model.editors.length > 4 ? <span>+{model.editors.length - 4}</span> : null}</span>{model.saved ? <span className="code-saved" data-saving={model.saved === "saving" || undefined}>{model.saved === "saving" ? "Saving…" : <><Check size={13} aria-hidden="true" />Saved to the machine</>}</span> : null}</span> : null}
      {model.gone ? <span className="code-file-state">{model.gone.kind === "deleted" ? <FileX size={13} aria-hidden="true" /> : <FileSymlink size={13} aria-hidden="true" />}{model.gone.kind === "deleted" ? "Deleted" : "Renamed"}</span> : null}
    </header> : header}
    <div className="smithers-card-body">
      {model.gone ? <>
        <div className="code-file-notice"><TriangleAlert size={14} aria-hidden="true" /><span>{model.gone.kind === "deleted" ? <>Deleted by {actorName(model.gone.by)}</> : <>Renamed to <code title={model.gone.to}>{model.gone.to.split("/").at(-1)}</code> by {actorName(model.gone.by)}</>}</span>{controls}</div>
        <div className="code-snapshot-cap"><History size={12} aria-hidden="true" />Snapshot</div>
      </> : model.outside ? <div className="code-file-notice code-notice" data-tone="outside"><FolderSync size={14} aria-hidden="true" /><span>Changed outside Smithers</span>{!model.unsaved && actions.length ? <span className="code-notice-actions">{buttons}</span> : null}</div> : null}
      {model.unsaved ? <div className="code-notice" data-tone="attention"><span>{model.unsaved.count} {model.unsaved.count === 1 ? "edit wasn't" : "edits weren't"} saved</span><span className="code-notice-actions"><button type="button" onClick={async () => { const copied = onCopy ? await onCopy() : (await copyText(model.unsaved!.text)).ok; setCopyFailed(!copied) }}>Copy</button>{!model.gone ? buttons : null}</span><pre>{model.unsaved.text}</pre>{copyFailed ? <span role="status">Copy failed</span> : null}</div> : null}
      {!model.gone && !model.outside && !model.unsaved ? controls : null}
      <div className={comparing ? "code-compare" : undefined}>
      <div className="code-file-current">
      {comparing ? <div className="code-compare-cap"><span>Current</span><code>{model.digest}</code></div> : null}
      <div className="code-file-editor" data-snapshot={model.gone ? "" : undefined}>
      {model.content.kind !== "text" ? <p className="code-file-size">{model.content.kind === "binary" ? "Binary file" : "Too large to co-edit"} · {formatBytes(model.content.bytes, "decimal")} {model.github_url ? <a href={model.github_url} target="_blank" rel="noreferrer">on GitHub ↗</a> : null}</p> :
        editor({ kind: "current", text: model.content.text, binding: visualBinding })}

      </div>
      </div>
      {comparing ? <div className="code-file-outside" data-version={comparison!.version}>
        <div className="code-compare-cap"><span>Snapshot</span><code>{comparison!.version}</code></div>
        {editor({ kind: "snapshot", text: comparison!.text })}
      </div> : null}
      </div>
    </div>
  </section>
}
