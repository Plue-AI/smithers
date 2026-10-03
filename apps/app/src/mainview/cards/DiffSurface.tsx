import { useMemo } from "react"
import { patchToCodeViewItems, PierreDiffView } from "@smthrs/ui/adapters/pierre-diff-view"
import type { DiffCard, DiffViewProps } from "@smthrs/rpc/DiffCard"
import { DiffAction } from "./views/DiffAction"
import { ActorChip, actorName } from "./views/ActorChip"
import { fileSize } from "./views/CodeEditorView"
/*
 * The diff card's hunks (docs/code-intel/PLAN.md §7, L5): one file's patch on
 * `@pierre/diffs` CodeView through `@smthrs/ui/adapters/pierre-diff-view`,
 * the engine and theme mapping the file card's CodeSurface runs on. The
 * adapter is heavy, so ChangeCards loads this module lazily: it is the async
 * chunk boundary and the only place in the app graph that imports the
 * adapter. A patch pierre cannot read stays the verbatim text the seam
 * carried: nothing is drawn that the server did not return.
 */

/**
 * plue writes each file's patch as go-difflib does (`internal/diffview/
 * diffview.go` buildUnifiedPatch): `--- a/path` / `+++ b/path` labels and the
 * hunks, no `diff --git` line. pierre names a file only from that line, and
 * without it reads the labels as a rename (`a/path → b/path`). The line is
 * built from the seam's own path fields; a patch that already carries one is
 * left alone.
 */
export const gitPatch = (file: { readonly path: string; readonly oldPath?: string | undefined; readonly patch: string }): string =>
  file.patch.startsWith("diff --git ") ? file.patch : `diff --git a/${file.oldPath ?? file.path} b/${file.path}\n${file.patch}`

/** pierre read the patch: it found a file, and every file it found has a hunk. A header with nothing under it is not a diff. */
const readable = (patch: string): boolean => {
  const items = patchToCodeViewItems(patch)
  return items.length > 0 && items.every((item) => item.type === "diff" && item.fileDiff.hunks.length > 0)
}

export const DiffSurface = ({
  path,
  oldPath,
  patch,
  unsafeCSS
}: {
  readonly path: string
  readonly oldPath?: string | undefined
  /** The file's unified patch as the change seam carried it. */
  readonly patch: string
  readonly unsafeCSS?: string
}) => {
  const headed = useMemo(() => gitPatch({ path, oldPath, patch }), [path, oldPath, patch])
  const parsed = useMemo(() => readable(headed), [headed])
  return parsed ? <PierreDiffView patch={headed} layout="inline" unsafeCSS={unsafeCSS} /> : <pre className="world-card-path">{patch}</pre>
}


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
export function DiffCardSurface({ model, actions, onAction }: DiffViewProps) {
  return <section className="smithers-card code-diff-view" data-kind="diff" data-keyboard-pane="Diff" aria-label={`${model.path} changes`}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{model.renamed_to ?? model.path}</h2><span className="mvp-branch-chip">{model.branch}</span></header>
    <div className="smithers-card-body">
      <div className="code-diff-base" data-against={model.against.kind}>{model.against.kind === "burst" ? <><ActorChip actor={model.against.actor} size="s" /><span>{actorName(model.against.actor)}</span><time>{model.against.at}</time></> : <code>{model.against.rev}</code>}</div>
      {model.binary ? <p className="code-file-size">Binary file · {fileSize(model.binary.before_bytes)} → {fileSize(model.binary.after_bytes)}</p> : model.hunks.length ? <DiffSurface path={model.renamed_to ?? model.path} patch={unifiedPatch(model)} unsafeCSS={paperDiffCss} /> : null}
      {actions.length ? <div className="code-actions">{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</div> : null}
    </div>
  </section>
}
