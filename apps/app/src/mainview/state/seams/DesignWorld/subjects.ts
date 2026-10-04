/*
 * MOCK SEAM, subjects lane (delete with ./index.ts). Issue, File, Diff, Wiki
 * page, Review findings and PR read the seeded world here; their stub flows
 * (flows/entries/subjects.ts) write it. Each card is a retained kind
 * (card-kinds.md §3) whose id starts with `design:`; cards/SubjectCards.tsx
 * reads the subject from the world by that id.
 *
 * What replaces each part:
 *   issues, issue-list   -> IssuesSeam (`issues.view`, `issues.list`), GitHub sync
 *   files, file-list     -> topic `branch:<id>:files`, /api/branches/{b}/files, Yjs
 *   diffs                -> ChangeSeam `change.diff` / the item's evidence diff
 *   wiki pages           -> the wiki collections and wiki.* flows
 *   reviews              -> the /review flow result (`change` findings)
 *   prs                  -> LandingsSeam `prs.view`
 */
import type { Card } from "../../AppState"
import type { FileCard } from "@smthrs/rpc/FileCard"
import type { DiffCard } from "@smthrs/rpc/DiffCard"
import type { ActorId, DesignCodeLine, DesignFile, DesignReview, DesignWorld, DesignWorldRows } from "./index"
import { BEN, RETRY_FILE, agentOf, branchOf, memberOf, todoOf } from "./index"
import { actorOf } from "./todo"

/** Every card this lane opens carries this id prefix; nothing else may. */
export const DESIGN_CARD = "design:"
export type SubjectKind = "issue" | "issues" | "file" | "files" | "diff" | "wiki" | "review" | "pr"
const SUBJECT_KINDS: ReadonlySet<string> = new Set<SubjectKind>(["issue", "issues", "file", "files", "diff", "wiki", "review", "pr"])

/** A subject card (`design:<kind>:…`); other `design:` cards (confirm) keep their kind's own family. */
export const isDesignCard = (card: { readonly id: string }): boolean =>
  card.id.startsWith(DESIGN_CARD) && SUBJECT_KINDS.has(card.id.slice(DESIGN_CARD.length).split(":")[0]!)

/** The subject a design card names: `design:<kind>:<subject>`. */
export const subjectOf = (card: { readonly id: string }): { readonly kind: SubjectKind; readonly subject: string } | undefined => {
  if (!isDesignCard(card)) return undefined
  const rest = card.id.slice(DESIGN_CARD.length)
  const at = rest.indexOf(":")
  const kind = (at === -1 ? rest : rest.slice(0, at)) as SubjectKind
  return { kind, subject: at === -1 ? "" : rest.slice(at + 1) }
}

/* ── Card rows (retained kinds, subject-only payloads) ─────── */

export type Present = Pick<Card, "id" | "kind" | "title" | "payload">

export const issueCard = (repo: string, number: number, title: string): Present => ({
  id: `${DESIGN_CARD}issue:${number}`, kind: "issue", title: `#${number} ${title}`,
  payload: { repo, number, title, state: "open", author: null, issueBody: "", labels: [], comments: [] }
} as Present)

export const issueListCard = (repo: string): Present => ({
  id: `${DESIGN_CARD}issues`, kind: "issue-list", title: "Issues", payload: { repo, filter: "open", issues: [] }
} as Present)

export const fileCard = (repo: string, branch: string, path: string, line?: number): Present => ({
  id: `${DESIGN_CARD}file:${branch}:${path}`, kind: "file", title: path.split("/").at(-1) ?? path,
  payload: { repo, path, content: "", truncated: false, ref: branch, ...(line === undefined ? {} : { line }) }
} as Present)

export const fileListCard = (repo: string, branch: string): Present => ({
  id: `${DESIGN_CARD}files:${branch}`, kind: "file-list", title: "Files", payload: { repo, path: "", entries: [] }
} as Present)

export const diffCard = (repo: string, subject: string, title: string): Present => ({
  id: `${DESIGN_CARD}diff:${subject}`, kind: "diff", title: `Diff · ${title}`,
  payload: { repo, changeId: subject, from: "parent", to: "current", pin: { changeId: subject, seq: null, commitId: null }, files: [] }
} as Present)

export const wikiCard = (pageId: string, title: string): Present => ({
  id: `${DESIGN_CARD}wiki:${pageId}`, kind: "world", title, payload: { documents: [] }
} as Present)

export const reviewCard = (repo: string, reviewId: string): Present => ({
  id: `${DESIGN_CARD}review:${reviewId}`, kind: "change", title: "Review",
  payload: {
    repo, changeId: reviewId, description: "Review", commitId: null, currentSeq: null, revisionCount: null, revisions: [],
    authorName: null, timestamp: null, repos: [], diff: null, checks: null, findings: null, reviews: null, threads: null,
    conflicts: null, stack: null, changeset: null
  }
} as Present)

export const prCard = (repo: string, number: number, title: string): Present => ({
  id: `${DESIGN_CARD}pr:${number}`, kind: "pr", title: `#${number} ${title}`,
  payload: { repo, number, title, state: "open", author: null, prBody: "", reviews: [], checks: [] }
} as Present)

/* ── Seeded subjects this lane adds to the j1 seed ─────────── */

/** T8's change (upgrade-stripe): the evidence diff the TODO's Diff opens. */
export const STRIPE_DIFF: ReadonlyArray<DiffCard> = [
  { path: "package.json", branch: "upgrade-stripe", against: { kind: "item_base", rev: "main" }, change: "modified", hunks: [{ old_start: 18, new_start: 18, lines: [
    { op: " ", text: "    \"pg\": \"^8.11.0\"," },
    { op: "-", text: "    \"stripe\": \"^16.12.0\"," },
    { op: "+", text: "    \"stripe\": \"^17.2.0\"," },
    { op: " ", text: "    \"zod\": \"^3.23.0\"" }
  ] }] },
  { path: "src/webhooks/verify.ts", branch: "upgrade-stripe", against: { kind: "item_base", rev: "main" }, change: "modified", hunks: [{ old_start: 7, new_start: 7, lines: [
    { op: " ", text: "export function verify(body: string, signature: string) {" },
    { op: "-", text: "  return stripe.webhooks.constructEvent(body, signature, SECRET)" },
    { op: "+", text: "  return stripe.webhooks.constructEvent(body, signature, SECRET, TOLERANCE)" },
    { op: " ", text: "}" }
  ] }] }
]

const REVIEW_ID = "review-retry"

/** /review on a branch: the seeded findings against T9's head; any other branch reads clean. */
export const ensureReview = (design: DesignWorld, branch = "b-retry"): DesignReview => {
  const existing = design.rows("reviews").find(each => each.branch === branch)
  if (existing !== undefined) return existing
  const review: DesignReview = branch === "b-retry"
    ? { id: REVIEW_ID, branch, by: `${BEN}~smithers`, verdict: "changes", findings: [
      { severity: "blocker", path: RETRY_FILE, line: 14, text: "redeliver() still sleeps a fixed 30 s." },
      { severity: "fix", path: RETRY_FILE, line: 8, text: "Use backoff(attempt), capped at 60 s." },
      { severity: "note", path: RETRY_FILE, line: 10, text: "Mark the event failed after the last attempt." }
    ] }
    : { id: `review-${branch}`, branch, by: `${BEN}~smithers`, verdict: "clean", findings: [] }
  design.put("reviews", review)
  return review
}

/** `/issue.new`: the next GitHub number, open, by the viewer. */
export const newIssue = (design: DesignWorld, title: string, body: string, by: ActorId): number => {
  const number = Math.max(0, ...design.rows("issues").map(each => each.number)) + 1
  design.put("issues", { number, title, body, author: by, age: "now", open: true, comments: [] })
  return number
}

/** `/issue.comment`: appends to the thread. */
export const commentIssue = (design: DesignWorld, number: number, text: string, by: ActorId): boolean =>
  design.patch("issues", number, issue => ({ ...issue, comments: [...issue.comments, { who: by, text, age: "now" }] })) !== undefined

/** `/wiki.page <name>` on a page that does not exist yet: r1, one empty block, by the viewer. */
export const newWikiPage = (design: DesignWorld, name: string, by: ActorId): string => {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"
  design.put("wiki", { id, title: name.trim(), rev: 1, authors: [by], lines: [{ n: 1, text: "" }] })
  return id
}

/* ── Projections into the rpc models the Views take ────────── */

/** Who is on which line of a file: the branch's presence rows plus the file's own editors. */
const editorsOf = (world: DesignWorldRows, file: DesignFile): FileCard["editors"] => {
  const branch = branchOf(world, file.branch)
  const present = (branch?.presence ?? []).flatMap(each => each.where.kind === "file" && each.where.path === file.path && each.where.line !== undefined
    ? [{ actor: actorOf(world, each.who), line: each.where.line }] : [])
  const typing = (file.editors ?? []).map(each => ({ actor: actorOf(world, each.who), line: each.line }))
  return [...typing, ...present.filter(row => !typing.some(other => other.line === row.line))]
}

const authorsOf = (world: DesignWorldRows, lines: ReadonlyArray<DesignCodeLine>): FileCard["authors"] =>
  [...new Set(lines.flatMap(line => line.by === undefined ? [] : [line.by]))].map(who => actorOf(world, who))

export const designFileCard = (world: DesignWorldRows, file: DesignFile, line?: number): FileCard => {
  const authors = authorsOf(world, file.lines)
  const last = file.lines.filter(each => each.by !== undefined).at(-1)?.by
  return {
    path: file.path, branch: branchOf(world, file.branch)?.name ?? file.branch, language: file.path.split(".").at(-1) ?? "", digest: `design:${file.id}`,
    github_url: `https://github.com/${world.repo.repo}/blob/${file.branch === "main" ? "main" : branchOf(world, file.branch)?.name ?? file.branch}/${file.path}`,
    content: { kind: "text", text: file.lines.map(each => each.text).join("\n") }, mode: "read_only",
    ...(last === undefined ? {} : { last_writer: actorOf(world, last) }),
    diagnostics: [],
    ...(line === undefined ? {} : { reveal: { line } }),
    ...(file.gone === undefined ? {} : { gone: file.gone.kind === "deleted" ? { kind: "deleted", by: actorOf(world, file.gone.by) } : { kind: "renamed", to: file.gone.to ?? file.path, by: actorOf(world, file.gone.by) } }),
    ...(file.outside === undefined ? {} : { outside: { version: `line ${file.outside.line}`, at: "now" } }),
    authors, editors: editorsOf(world, file),
    saved: (file.editors ?? []).length > 0 ? "saving" : "saved"
  }
}

/*
 * The File card's hover and definition gestures, answered from the seeded
 * source until code.hover and code.definition reach a language server for
 * design files: the declaration line as the hover, its place as the reveal.
 */
const identifierAt = (text: string, col: number): string | undefined => {
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) if (col >= match.index && col < match.index + match[0].length) return match[0]
  return undefined
}
const declarationColumn = (text: string, name: string): number | undefined => {
  const word = name.replace(/\$/g, "\\$")
  const match = new RegExp(`\\b(?:const|let|var|function|class|type|interface|enum)\\s+${word}\\b|\\bimport\\s+(?:type\\s+)?(?:\\{[^}]*\\b${word}\\b|${word}\\b)`).exec(text)
  return match === null ? undefined : text.indexOf(name, match.index + 1)
}

/** F12 / Ctrl-click: where the identifier at (line, col) is declared in this file. */
export const designDefinition = (file: DesignFile, line: number, col: number): FileCard["reveal"] | undefined => {
  const name = identifierAt(file.lines.find(each => each.n === line)?.text ?? "", col)
  if (name === undefined) return undefined
  for (const each of file.lines) {
    const at = declarationColumn(each.text, name)
    if (at !== undefined && at >= 0) return { line: each.n, col: at }
  }
  return undefined
}

/** Ctrl-hover / Shift-F10: the identifier's declaration, or the identifier itself. */
export const designHover = (file: DesignFile, line: number, col: number): FileCard["hover"] | undefined => {
  const name = identifierAt(file.lines.find(each => each.n === line)?.text ?? "", col)
  if (name === undefined) return undefined
  const target = designDefinition(file, line, col)
  const declared = target === undefined ? undefined : file.lines.find(each => each.n === target.line)?.text.trim().replace(/\s*\{$/, "")
  return { line, col, markdown: `\`${(declared ?? name).replace(/`/g, "'")}\`` }
}

const CONTEXT = 2
type DiffLine = DiffCard["hunks"][number]["lines"][number]
const isEdited = (line: DesignCodeLine): line is DesignCodeLine & { was: string } => line.was !== undefined && line.was !== line.text

/** Each edited line with two lines of context; hunks that touch, or leave one line between them, merge. */
const hunksOf = (lines: ReadonlyArray<DesignCodeLine>): DiffCard["hunks"] => {
  const ranges: Array<[number, number]> = []
  lines.forEach((line, index) => {
    if (!isEdited(line)) return
    const from = Math.max(0, index - CONTEXT)
    const to = Math.min(lines.length - 1, index + CONTEXT)
    const last = ranges.at(-1)
    if (last !== undefined && from <= last[1] + 2) last[1] = to
    else ranges.push([from, to])
  })
  return ranges.map(([from, to]) => ({ old_start: lines[from]!.n, new_start: lines[from]!.n, lines: lines.slice(from, to + 1).flatMap((line): DiffLine[] =>
    isEdited(line) ? [{ op: "-", text: line.was }, { op: "+", text: line.text }] : [{ op: " ", text: line.text }]) }))
}

/** The working copy of one file against the item's base; against a burst when an outside write is what changed it. */
export const designDiffCard = (world: DesignWorldRows, file: DesignFile): DiffCard => {
  const branch = branchOf(world, file.branch)
  const outside = file.outside
  const by = file.lines.find(isEdited)?.by
  return {
    path: file.path, branch: branch?.name ?? file.branch,
    against: outside !== undefined && by !== undefined && by !== agentOf(file.branch) && memberOf(world, by) === undefined
      ? { kind: "burst", burst: `${file.id}@${outside.line}`, actor: actorOf(world, by), at: "now" }
      : { kind: "item_base", rev: branch?.from ?? "main" },
    change: file.gone?.kind === "deleted" ? "deleted" : "modified",
    hunks: hunksOf(file.lines)
  }
}

/** What `/diff` shows for a subject: one file, a branch's changed files, or T8's seeded evidence diff. */
export const designDiffs = (world: DesignWorldRows, subject: string): ReadonlyArray<DiffCard> => {
  const file = world.files.find(each => each.id === subject)
  if (file !== undefined) return [designDiffCard(world, file)]
  const todo = todoOf(world, subject)
  const branch = todo?.branch ?? subject
  if (branch === "b-stripe") return STRIPE_DIFF
  return world.files.filter(each => each.branch === branch && each.lines.some(isEdited)).map(each => designDiffCard(world, each))
}

/* ── Lookups the stub flows resolve their input with ──────── */

export const issueNumberOf = (text: string | number | undefined): number | undefined => {
  const n = Number(String(text ?? "").trim().replace(/^#/, ""))
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** A path, `branch:path`, or a basename; the asked branch first, then the viewer's branch, then any. */
export const findFile = (world: DesignWorldRows, path: string, branch?: string, viewer?: ActorId): DesignFile | undefined => {
  const [maybeBranch, rest] = path.includes(":") ? path.split(":", 2) as [string, string] : [undefined, path]
  const wantBranch = branch ?? maybeBranch
  const matches = world.files.filter(each => each.path === rest || each.path.endsWith(`/${rest}`))
  const mine = viewer === undefined ? undefined : world.branches.find(each => each.presence.some(row => row.who === viewer))?.id
  return matches.find(each => each.branch === wantBranch || each.branch === world.branches.find(row => row.name === wantBranch)?.id)
    ?? matches.find(each => each.branch === mine) ?? matches[0]
}

export const findWikiPage = (world: DesignWorldRows, name: string) => {
  const needle = name.trim().toLowerCase()
  return world.wiki.find(each => each.id === needle || each.title.toLowerCase() === needle)
    ?? world.wiki.find(each => each.title.toLowerCase().includes(needle))
}

/** A branch by id, name or the TODO ref it works (`b-retry`, `retry-webhooks`, `T9`). */
export const findBranch = (world: DesignWorldRows, name: string) =>
  world.branches.find(each => each.id === name || each.name === name)
    ?? world.branches.find(each => each.item !== undefined && todoOf(world, each.item)?.ref.toLowerCase() === name.toLowerCase())
