/*
 * File and Diff cards on a branch: both read the one shared working copy and
 * update live (mvp.md §6.8, M-02).
 *
 * The File card is drawn as the CodeMirror 6 editor it becomes: a gutter of
 * name flags, a diagnostics gutter and line numbers beside the code, and code
 * intelligence on hover. Each person's changed characters carry their colour.
 * Every other editor has a flag in the gutter on their line, so flags never
 * sit on code; only your own typing shows a caret, because carets and
 * selections of others are cut. There is no Save button: the live document
 * saves to the machine continuously. A file deleted or renamed from outside
 * keeps its last content, marked as a snapshot.
 */
import type { CSSProperties, ReactNode } from "react"
import { Button } from "@smthrs/ui"
import { Check, FileSymlink, FileX, FolderSync, History, TriangleAlert } from "lucide-react"
import { actorName, Avatar, AvatarStack, BranchChip, Card, flagName, identityColour } from "../parts"
import { useFrame } from "../frame"
import { file as fileOf, isAgent, member, via, type ActorId, type CodeLine, type World } from "../world"

/* main is GitHub's trunk, with no machine; a file there gets a main chip, not a branch. */
const Where = ({ world, id }: { readonly world: World; readonly id: string }) => {
  const branch = world.branches.find(each => each.id === id)
  return branch === undefined || id === "main" ? <span className="mvp-branch-chip" data-main>main</span> : <BranchChip branch={branch} />
}

const colourOf = (world: World, who: ActorId | undefined): CSSProperties | undefined => who === undefined ? undefined : identityColour(world, who)



/** The unabbreviated name, for a title: "Alice Park", "Smithers for Ben", "Coding agent". */
const fullName = (world: World, who: ActorId): string =>
  via(who) !== undefined || isAgent(who) ? actorName(world, who) : member(world, who)?.name ?? who

/**
 * What `next` changed from `prev`: their common prefix and suffix trimmed.
 * [from, to) is the changed span in `next`; [from, wasTo) the span it replaced in `prev`.
 */
const spanOf = (prev: string, next: string): { readonly from: number; readonly to: number; readonly wasTo: number } => {
  const most = Math.min(prev.length, next.length)
  let from = 0
  while (from < most && prev[from] === next[from]) from += 1
  let tail = 0
  while (tail < most - from && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1
  return { from, to: next.length - tail, wasTo: prev.length - tail }
}

const isWord = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char)

/** The changed span widened to whole words, so a diff reads "24 * 60" to "30", not "24 * 6" to "3". */
const wordSpanOf = (prev: string, next: string): { readonly from: number; readonly to: number; readonly wasTo: number } => {
  let { from, to, wasTo } = spanOf(prev, next)
  while (from > 0 && isWord(next[from - 1]) && (isWord(next[from]) || isWord(prev[from]))) from -= 1
  while (to < next.length && isWord(next[to]) && (isWord(next[to - 1]) || isWord(prev[wasTo - 1]))) { to += 1; wasTo += 1 }
  return { from, to, wasTo }
}

/** Text with one span marked; an empty span (a pure deletion) marks nothing. */
const Marked = ({ text, from, to, mark }: { readonly text: string; readonly from: number; readonly to: number; readonly mark: (span: string) => ReactNode }) =>
  from >= to ? <>{text}</> : <>{text.slice(0, from)}{mark(text.slice(from, to))}{text.slice(to)}</>

/** "lines:4-9" shows an excerpt with that range marked: how an answer cites code. */
const rangeOf = (view: string | undefined): [number, number] | undefined => {
  const match = /^lines:(\d+)-(\d+)$/.exec(view ?? "")
  return match === null ? undefined : [Number(match[1]), Number(match[2])]
}

/* ── Code intelligence ──────────────────────────────────────── */

/** What the language server and linter know about a file, as the editor shows it. */
interface Intel {
  /** A symbol's signature and where it is defined, shown when you hover it. */
  readonly hover: { readonly symbol: string; readonly type: string; readonly from: string }
  /** An imported name the linter flags while nothing else in the file uses it. */
  readonly unusedImport: string
}

const INTEL: Readonly<Record<string, Intel>> = {
  "src/webhooks/retry.ts": { hover: { symbol: "backoff", type: "backoff(attempt: number): number", from: "lib/backoff.ts" }, unusedImport: "backoff" }
}

const wordOf = (symbol: string): RegExp => new RegExp(`\\b${symbol}\\b`)
const isImport = (text: string): boolean => /^\s*import\b/.test(text)

/** Lint warnings by line number: an import the rest of the file never uses. */
const lintOf = (intel: Intel | undefined, rows: ReadonlyArray<{ readonly line: CodeLine; readonly text: string }>): ReadonlyMap<number, string> => {
  if (intel === undefined) return new Map()
  const word = wordOf(intel.unusedImport)
  if (rows.some(row => !isImport(row.text) && word.test(row.text))) return new Map()
  return new Map(rows.filter(row => isImport(row.text) && word.test(row.text)).map(row => [row.line.n, `'${intel.unusedImport}' is defined but never used.`]))
}

/* ── File ───────────────────────────────────────────────────── */

/** Everyone else on a line: the first one's short name, and how many more. */
const Flag = ({ world, who }: { readonly world: World; readonly who: ReadonlyArray<ActorId> }) => {
  const first = who[0]
  if (first === undefined) return null
  return (
    <span className="mvp-code-flag" style={colourOf(world, first)} title={who.map(each => fullName(world, each)).join(", ")}>
      <span className="mvp-code-flag-name">{flagName(world, first)}</span>{who.length > 1 ? <b>+{who.length - 1}</b> : null}
    </span>
  )
}

export const FileCard = ({ id, target, view }: { readonly id: string; readonly target: string; readonly view?: string }) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const doc = fileOf(world, target)
  const range = rangeOf(view)
  /* A live co-editor, unless the card cites an excerpt or the file left the working copy. */
  const live = range === undefined && doc.gone === undefined
  const editors = live ? doc.editors ?? [] : []
  const mine = editors.find(each => each.who === frame.me)?.line
  const typedOf = (n: number): string | undefined => live ? frame.typed[`line:${doc.path}:${n}`] : undefined
  const typists = editors.filter(each => typedOf(each.line) !== undefined).map(each => each.who)
  /* A typed line nobody sits on belongs to the one person typing elsewhere (a rename touching two call sites). */
  const typistOf = (n: number): ActorId | undefined => editors.find(each => each.line === n)?.who ?? (typists.length === 1 ? typists[0] : undefined)
  const rows = doc.lines.map(line => {
    const typed = typedOf(line.n)
    return { line, typed, text: typed ?? line.text }
  })
  const typing = rows.some(row => row.typed !== undefined)
  const intel = INTEL[doc.path]
  const lint = lintOf(intel, rows)
  const shown = rows.filter(({ line }) => range === undefined || (line.n >= range[0] - 1 && line.n <= range[1] + 1))
  const cited = (n: number): true | undefined => range !== undefined && n >= range[0] && n <= range[1] ? true : undefined
  const end = range !== undefined ? undefined : doc.gone !== undefined ? (
    <span className="mvp-file-state">
      {doc.gone.kind === "deleted" ? <FileX size={13} aria-hidden="true" /> : <FileSymlink size={13} aria-hidden="true" />}
      {doc.gone.kind === "deleted" ? "Deleted" : "Renamed"}
    </span>
  ) : (
    <span className="mvp-file-head">
      <AvatarStack world={world} who={editors.map(each => each.who)} />
      <span className="mvp-saved" data-saving={typing || undefined}>
        {typing ? <><span className="mvp-saving-mark" aria-hidden="true" />Saving…</> : <><Check size={13} aria-hidden="true" />Saved to the machine</>}
      </span>
    </span>
  )
  return (
    <Card id={id} kind="file" title={<span className="mvp-mono">{doc.path}</span>} status={<Where world={world} id={doc.branch} />} end={end}>
      {doc.gone === undefined ? null : (
        <>
          <div className="mvp-file-notice" data-mock="file-gone">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{doc.gone.kind === "deleted"
              ? `Deleted by ${actorName(world, doc.gone.by)}`
              : <>Renamed to <code>{doc.gone.to?.split("/").at(-1)}</code> by {actorName(world, doc.gone.by)}</>}</span>
            <span className="mvp-actions-end"><Button size="sm" variant="outline">{doc.gone.kind === "deleted" ? "Restore" : "Follow"}</Button></span>
          </div>
          <div className="mvp-snapshot-cap"><History size={12} aria-hidden="true" />Snapshot</div>
        </>
      )}
      {doc.outside === undefined || doc.gone !== undefined ? null : (
        <div className="mvp-file-notice" data-tone="outside" data-mock="file-outside">
          <FolderSync size={14} aria-hidden="true" />
          <span>Changed outside Smithers</span>
          <span className="mvp-actions-end"><Button size="sm" variant="outline" data-mock="file-compare">Compare</Button></span>
        </div>
      )}
      {doc.outside === undefined || view !== "compare" ? null : (
        <div className="mvp-compare" role="group" aria-label="Live and outside versions">
          <div><span className="mvp-compare-cap">Live</span><code>{doc.lines.find(line => line.n === doc.outside!.line)?.text}</code></div>
          <div><span className="mvp-compare-cap">Outside</span><code>{doc.outside.text}</code></div>
        </div>
      )}
      <div className="mvp-editor" data-snapshot={doc.gone === undefined ? undefined : true}>
        <div className="mvp-editor-scroller">
          <div className="mvp-editor-gutters" aria-hidden="true">
            {live ? (
              <div className="mvp-editor-gutter" data-gutter="flags">
                {shown.map(({ line }) => <div key={line.n}><Flag world={world} who={editors.filter(each => each.line === line.n && each.who !== frame.me).map(each => each.who)} /></div>)}
              </div>
            ) : null}
            <div className="mvp-editor-gutter" data-gutter="lint">
              {shown.map(({ line }) => <div key={line.n}>{lint.has(line.n) ? <span className="mvp-lint-mark" title={lint.get(line.n)} /> : null}</div>)}
            </div>
            <div className="mvp-editor-gutter" data-gutter="numbers">
              {shown.map(({ line }) => <div key={line.n} data-cited={cited(line.n)} data-active={line.n === mine || undefined}>{line.n}</div>)}
            </div>
          </div>
          <div className="mvp-editor-content" role="group" aria-label={doc.path}>
            {shown.map(({ line, typed, text }) => {
              const { n } = line
              /* Live typing is measured against the line as saved; a saved edit against the line before it. */
              const author = typed === undefined ? (line.was === undefined ? undefined : line.by) : typistOf(n)
              const span = spanOf(typed === undefined ? line.was ?? line.text : line.text, text)
              /* Your pointer rests on a symbol you just wrote: its signature and where it is defined. */
              const symbol = intel !== undefined && n === mine && typed === undefined && line.seq === seq ? wordOf(intel.hover.symbol).exec(text) : null
              const tip = intel === undefined || symbol === null ? undefined : { ...intel.hover, col: symbol.index }
              return (
                <div key={n} className="mvp-editor-line" data-cited={cited(n)} data-active={n === mine || undefined}
                  data-hover={tip === undefined ? undefined : n === shown[0]?.line.n ? "below" : "above"}>
                  {author === undefined ? text : (
                    <Marked text={text} from={span.from} to={span.to} mark={changed => (
                      <span className="mvp-span" data-fresh={typed === undefined && line.seq === seq ? true : undefined}
                        style={colourOf(world, author)} title={fullName(world, author)}>{changed}</span>
                    )} />
                  )}
                  {typed !== undefined && author === frame.me ? <span className="mvp-caret" style={colourOf(world, author)} aria-hidden="true" /> : null}
                  {tip === undefined ? null : (
                    <span className="mvp-editor-tip" role="tooltip" style={{ "--col": tip.col } as CSSProperties}>
                      <code>{tip.type}</code><span>· {tip.from}</span>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </Card>
  )
}

/* ── Diff ───────────────────────────────────────────────────── */

const CONTEXT = 2

const isEdited = (line: CodeLine): line is CodeLine & { was: string } => line.was !== undefined && line.was !== line.text

/** Each edited line with two lines of context; hunks that touch, or leave one line between them, merge. */
const hunksOf = (lines: ReadonlyArray<CodeLine>): Array<ReadonlyArray<CodeLine>> => {
  const ranges: Array<[number, number]> = []
  lines.forEach((line, index) => {
    if (!isEdited(line)) return
    const from = Math.max(0, index - CONTEXT)
    const to = Math.min(lines.length - 1, index + CONTEXT)
    const last = ranges.at(-1)
    if (last !== undefined && from <= last[1] + 2) last[1] = to
    else ranges.push([from, to])
  })
  return ranges.map(([from, to]) => lines.slice(from, to + 1))
}

const DiffRow = ({ kind, old, now, children }: { readonly kind: "context" | "del" | "add"; readonly old?: number; readonly now?: number; readonly children: ReactNode }) => (
  <div className="mvp-diff-row" data-diff={kind}>
    <span className="mvp-diff-n">{old}</span>
    <span className="mvp-diff-n">{now}</span>
    <span className="mvp-diff-sign">{kind === "add" ? "+" : kind === "del" ? "−" : ""}</span>
    <span className="mvp-diff-text">{children}</span>
  </div>
)

/*
 * The working copy against the item's base, as unified hunks with old and new
 * line numbers. Each hunk names its authors once, with their avatars; inside
 * it, every changed span carries its author's colour.
 */
/* view "outside": the diff an external-change entry opens. Its one action puts the file back as it was before the burst (B.4 file.restore). */
export const DiffCard = ({ id, target, view }: { readonly id: string; readonly target: string; readonly view?: string }) => {
  const frame = useFrame()
  const { world, seq } = frame.state
  const doc = fileOf(world, target)
  const edited = doc.lines.filter(isEdited)
  const hunks = hunksOf(doc.lines)
  return (
    <Card id={id} kind="diff" title={<span className="mvp-mono">{doc.path}</span>} status={<Where world={world} id={doc.branch} />}
      end={<span className="mvp-diffstat"><b className="mvp-add">+{edited.length}</b> <b className="mvp-del">−{edited.length}</b></span>}>
      {hunks.length === 0 ? null : (
        <div className="mvp-code mvp-diff" role="group" aria-label={`${doc.path} changes`}>
          {hunks.map(hunk => {
            const authors = [...new Set(hunk.filter(isEdited).flatMap(line => line.by === undefined ? [] : [line.by]))]
            return (
              <div key={hunk[0]!.n} className="mvp-diff-hunk">
                <div className="mvp-diff-head">
                  <span className="mvp-avatar-stack" aria-label={authors.map(each => actorName(world, each)).join(", ")}>
                    {authors.map(each => <Avatar key={each} world={world} who={each} size={18} />)}
                  </span>
                  <span className="mvp-diff-at">lines {hunk[0]!.n}–{hunk.at(-1)!.n}</span>
                </div>
                {hunk.map(line => {
                  if (!isEdited(line)) return <DiffRow key={line.n} kind="context" old={line.n} now={line.n}>{line.text}</DiffRow>
                  const span = wordSpanOf(line.was, line.text)
                  return [
                    <DiffRow key={`${line.n}-`} kind="del" old={line.n}>
                      <Marked text={line.was} from={span.from} to={span.wasTo} mark={gone => <span className="mvp-span" data-del>{gone}</span>} />
                    </DiffRow>,
                    <DiffRow key={`${line.n}+`} kind="add" now={line.n}>
                      <Marked text={line.text} from={span.from} to={span.to} mark={added => line.by === undefined ? added : (
                        <span className="mvp-span" data-fresh={line.seq === seq || undefined} style={colourOf(world, line.by)} title={fullName(world, line.by)}>{added}</span>
                      )} />
                    </DiffRow>
                  ]
                })}
              </div>
            )
          })}
        </div>
      )}
      {view === "outside" ? (
        <div className="mvp-actions"><span className="mvp-actions-end"><Button size="sm" variant="outline" data-mock="file-restore">Restore this file</Button></span></div>
      ) : null}
    </Card>
  )
}
