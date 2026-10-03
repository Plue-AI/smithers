import type { DiffCard, DiffViewProps } from "@smthrs/rpc/DiffCard"
import { DiffAction } from "./DiffAction"
import { PierreDiffView } from "@smthrs/ui/adapters/pierre-diff-view"
import { ActorChip, actorName } from "./ActorChip"
import { fileSize } from "./CodeEditorView"

// Git quotes special path bytes; newline-containing paths cannot inject patch headers.
const gitPath = (path: string) => /[\s"\\]/.test(path) ? JSON.stringify(path) : path
export function unifiedPatch(model: DiffCard): string {
  const next = model.renamed_to ?? model.path
  const oldPath = gitPath(`a/${model.path}`), newPath = gitPath(`b/${next}`)
  const rename = model.change === "renamed" ? `rename from ${gitPath(model.path)}\nrename to ${gitPath(next)}\n` : ""
  return `diff --git ${oldPath} ${newPath}\n${rename}--- ${model.change === "added" ? "/dev/null" : oldPath}\n+++ ${model.change === "deleted" ? "/dev/null" : newPath}\n` + model.hunks.map(hunk => {
    const oldCount = hunk.lines.filter(line => line.op !== "+").length
    const newCount = hunk.lines.filter(line => line.op !== "-").length
    return `@@ -${hunk.old_start},${oldCount} +${hunk.new_start},${newCount} @@\n${hunk.lines.map(line => `${line.op}${line.text}\n`).join("")}`
  }).join("")
}
// Static Paper overrides: Pierre inline syntax colours fail AA on changed-line backgrounds.
const paperDiffCss = `pre { --diffs-bg: var(--surface); --diffs-fg: var(--code-text); } [data-diffs-header] { background: var(--surface-2); color: var(--text); } [data-line] span[style] { color: var(--code-text) !important; } :focus-visible { outline: 2px solid var(--ring-border); }`
export function DiffView({ model, actions, onAction }: DiffViewProps) {
  return <section className="smithers-card code-diff-view" data-kind="diff" data-keyboard-pane="Diff" aria-label={`${model.path} changes`}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.renamed_to ?? model.path}</h2><span className="mvp-branch-chip">{model.branch}</span></header>
    <div className="smithers-card-body">
      <div className="code-diff-base" data-against={model.against.kind}>{model.against.kind === "burst" ? <><ActorChip actor={model.against.actor} size="s" /><span>{actorName(model.against.actor)}</span><time>{model.against.at}</time></> : <code>{model.against.rev}</code>}</div>
      {model.binary ? <p className="code-file-size">Binary file · {fileSize(model.binary.before_bytes)} → {fileSize(model.binary.after_bytes)}</p> : model.hunks.length ? <PierreDiffView patch={unifiedPatch(model)} layout="inline" unsafeCSS={paperDiffCss} /> : null}
      {actions.length ? <div className="code-actions">{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</div> : null}
    </div>
  </section>
}
