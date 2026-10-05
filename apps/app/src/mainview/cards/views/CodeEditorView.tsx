import type { EditorBinding } from "@smthrs/ui/adapters/code-editor"
import type { ReactNode } from "react"
import type { CodeEditorViewProps as FileEditorProps } from "@smthrs/rpc/FileCard"
import { ActorChip, actorName } from "./ActorChip"
import { DiffAction } from "./DiffAction"
import { FileX, FileSymlink, FolderSync, History, TriangleAlert } from "lucide-react"
import { formatBytes } from "./formatBytes"

/** S1 File presentation. The card supplies authority; content changes keep the same CodeMirror instance. */
export const CodeEditorView = ({ model, actions, onAction, binding, editor }: FileEditorProps & { readonly binding?: EditorBinding; readonly editor: ReactNode }) => {
  const controls = actions.length ? <div className="code-actions">{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</div> : null
  return <section className="smithers-card code-file-view" data-kind="file" data-keyboard-pane="File" data-digest={model.digest || undefined} data-mode={binding && model.mode === "live" && model.content.kind === "text" && !model.gone ? "live" : "read_only"} aria-label={model.path}>
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
        editor}

      </div>
    </div>
  </section>
}
