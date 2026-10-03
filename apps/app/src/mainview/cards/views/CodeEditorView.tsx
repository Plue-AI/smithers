import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import { Editor } from "./Editor"
import { ActorChip, actorName } from "./ActorChip"

export const fileSize = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1_000 ? `${(bytes / 1_000).toFixed(1)} kB` : `${bytes} B`

export function CodeEditorView({ model, gestures, onAction, onView }: CodeEditorViewProps) {
  return <section className="smithers-card code-file-view" data-kind="file" data-keyboard-pane="File" data-digest={model.digest} data-mode={model.mode} aria-label={model.path}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.path}</h2><span className="mvp-branch-chip">{model.branch}</span>
      {model.last_writer ? <span className="code-writer" title={actorName(model.last_writer)}><ActorChip actor={model.last_writer} size="s" /></span> : null}
    </header>
    <div className="smithers-card-body">
      {model.content.kind === "text" ? <Editor path={model.path} text={model.content.text} language={model.language} diagnostics={model.diagnostics} hover={model.hover} reveal={model.reveal} gestures={gestures} onAction={onAction} onView={onView} /> : <p className="code-file-size">{model.content.kind === "binary" ? "Binary file" : "Too large to show"} · {fileSize(model.content.bytes)} {model.github_url ? <a href={model.github_url} target="_blank" rel="noreferrer">on GitHub ↗</a> : null}</p>}
      {model.diagnostics.length ? <ul className="code-diagnostics">{model.diagnostics.map((diagnostic, index) => <li key={index} data-severity={diagnostic.severity}>{diagnostic.message}</li>)}</ul> : null}
    </div>
  </section>
}
