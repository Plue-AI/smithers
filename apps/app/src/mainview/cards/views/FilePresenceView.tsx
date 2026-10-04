import { Check, FolderSync } from "lucide-react"
import { useState } from "react"
import type { CSSProperties } from "react"
import { CodeFileView } from "@smthrs/ui/adapters/code-view"
import { formatBytes } from "./formatBytes"
import { CardActionButton } from "./CardActionButton"
import { copyText } from "@smthrs/ui/copy"
import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import { ActorChip, actorName, actorColour } from "./ActorChip"

export function FilePresenceView({ model, actions, onAction }: CodeEditorViewProps) {
  const [copyFailed, setCopyFailed] = useState(false)
  const controls = actions.map((action, i) => <CardActionButton key={i} action={action} onAction={onAction} />)
  const annotations = model.mode === "live" ? [...new Set(model.editors.map(editor => editor.line))].map(line => {
    const actors = model.editors.filter(editor => editor.line === line).map(editor => editor.actor)
    return { key: `presence-${line}`, line, node: <span className="code-name-flag" title={actors.map(actorName).join(", ")} data-kind={actors[0]!.kind} style={{ "--who": actorColour(actors[0]!) } as CSSProperties}><span>{actorName(actors[0]!)}</span>{actors.length > 1 ? <b>+{actors.length - 1}</b> : null}</span> }
  }) : []
  return <section className="smithers-card code-file-view" data-kind="file" data-keyboard-pane="File" data-digest={model.digest} data-mode="read_only" aria-label={model.path}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.path}</h2><span className="mvp-branch-chip">{model.branch}</span>
      {model.mode === "live" ? <span className="code-live-head"><span className="code-avatar-stack" aria-label={model.editors.map(editor => actorName(editor.actor)).join(", ")}>{model.editors.slice(0, 4).map((editor, i) => <ActorChip key={i} actor={editor.actor} size="s" />)}{model.editors.length > 4 ? <span>+{model.editors.length - 4}</span> : null}</span>{model.saved ? <span className="code-saved" data-saving={model.saved === "saving" || undefined}>{model.saved === "saving" ? <>Saving…</> : <><Check size={13} aria-hidden="true" />Saved to the machine</>}</span> : null}</span> : null}
    </header>
    <div className="smithers-card-body">
      {model.outside ? <div className="code-notice" data-tone="outside"><FolderSync size={14} aria-hidden="true" /><span>Changed outside Smithers</span>{!model.unsaved ? <span className="code-notice-actions">{controls}</span> : null}</div> : null}
      {model.unsaved ? <div className="code-notice" data-tone="attention"><span>{model.unsaved.count} {model.unsaved.count === 1 ? "edit wasn't" : "edits weren't"} saved</span><span className="code-notice-actions"><button type="button" onClick={async () => { const result = await copyText(model.unsaved!.text); setCopyFailed(!result.ok) }}>Copy</button>{controls}</span><pre>{model.unsaved.text}</pre>{copyFailed ? <span role="status">Copy failed</span> : null}</div> : null}
      {!model.unsaved && !model.outside && actions.length ? <div className="code-actions">{controls}</div> : null}
      {model.content.kind === "text" ? <CodeFileView monochrome name={model.path} contents={model.content.text} line={model.reveal?.line} annotations={annotations} /> : <p className="code-file-size">{model.content.kind === "binary" ? "Binary file" : "Too large to co-edit"} · {formatBytes(model.content.bytes, "decimal")} {model.github_url ? <a href={model.github_url} target="_blank" rel="noreferrer">on GitHub ↗</a> : null}</p>}
    </div>
  </section>
}
