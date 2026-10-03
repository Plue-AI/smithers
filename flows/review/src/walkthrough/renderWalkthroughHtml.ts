import { Effect, Logger } from "effect"
import { extractDiffAssets } from "../diffs/extractDiffAssets.ts"
import { renderFallbackDiffHtml } from "../diffs/renderFallbackDiffHtml.ts"
import { renderPierreFileDiff } from "../diffs/renderPierreFileDiff.ts"
import { pluralize } from "../text/pluralize.ts"
import { ReviewCommentSeverity } from "../workflow/reviewCommentSeveritySchema.ts"
import type { ReviewRunOutput } from "../workflow/reviewRunOutputSchema.ts"
import type { ChangedFile } from "./changedFileSchema.ts"
import { describeChange } from "./describeChange.ts"
import { escapeHtml } from "./escapeHtml.ts"
import { formatUtcTimestamp } from "./formatUtcTimestamp.ts"
import { humanizeExcludeReason } from "./humanizeExcludeReason.ts"
import { mermaidLoaderScript } from "./mermaidLoaderScript.ts"
import { mermaidRuntimeGzipBase64 } from "./mermaidRuntimeGzipBase64.ts"
import { renderOverviewChart } from "./renderOverviewChart.ts"
import { renderProse, renderProseInline } from "./renderProse.ts"
import type { ReviewOutcome } from "./reviewOutcome.ts"
import type { Story, StoryBlock } from "./storySchema.ts"
import { walkthroughCss, walkthroughRestoreCss } from "./walkthroughCss.ts"
import { walkthroughScript } from "./walkthroughScript.ts"

type ReviewComment = ReviewRunOutput["comments"][number]

const OPEN_DIFF_MAX_CHURN = 300
// Above this churn the diff is rendered by the plain fallback renderer (which
// truncates) instead of the fully highlighted Pierre renderer.
const PIERRE_MAX_CHURN = 5_000

const severityOrder = ReviewCommentSeverity.literals

const faviconSvg = `data:image/svg+xml,${
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔍</text></svg>`
  )
}`

function severityOf(comment: ReviewComment): (typeof severityOrder)[number] {
  return (severityOrder as ReadonlyArray<string>).includes(comment.severity)
    ? (comment.severity)
    : "minor"
}

function statChip(insertions: number, deletions: number): string {
  return `<span class="stat"><span class="plus">+${insertions}</span> <span class="minus">−${deletions}</span></span>`
}

function findingLocation(comment: ReviewComment): string {
  if (comment.startLine <= 0) return ""
  return `Lines ${comment.startLine}${comment.endLine > comment.startLine ? `–${comment.endLine}` : ""}`
}

function findingCard(comment: ReviewComment, findingId: string): string {
  const severity = severityOf(comment)
  const loc = findingLocation(comment)
  const locChip = loc
    ? `<a class="finding-loc" data-line-link href="#${findingId}">${escapeHtml(loc)}</a>`
    : `<span class="finding-loc">whole file</span>`
  const confidence = comment.confidence !== "confirmed" ? `<span class="conf-tag">plausible</span>` : ""
  const body = comment.content
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("")
  const existing = comment.existingCode
    ? `<div class="code-label">Existing code</div><pre class="existing"><code>${
      escapeHtml(comment.existingCode)
    }</code></pre>`
    : ""
  const suggestion = comment.suggestionCode
    ? `<div class="code-label">Suggested</div><pre class="suggested"><button type="button" class="copy-btn" data-copy>Copy</button><code>${
      escapeHtml(comment.suggestionCode)
    }</code></pre>`
    : ""
  return [
    `<aside class="finding sev-${severity}" id="${findingId}" data-severity="${severity}" data-start-line="${comment.startLine}" data-end-line="${comment.endLine}">`,
    `<div class="finding-head"><span class="sev-chip sev-${severity}">${severity}</span><span class="cat-chip">${
      escapeHtml(comment.category)
    }</span>${confidence}${locChip}</div>`,
    `<div class="finding-body">${body}</div>`,
    existing,
    suggestion,
    `</aside>`
  ].join("")
}

function renamePaths(file: ChangedFile): { from: string; to: string } | null {
  if (file.status !== "renamed") return null
  const from = /^rename from (.+)$/m.exec(file.diff)
  const to = /^rename to (.+)$/m.exec(file.diff)
  if (!from || !to) return null
  return { from: from[1]!, to: to[1]! }
}

type DiffRender = { body: string; renderer: "pierre" | "fallback"; note: "" | "oversize" | "error" }

function diffSection(
  file: ChangedFile,
  intro: string,
  findings: Array<{ comment: ReviewComment; id: string }>,
  anchor: string,
  render: DiffRender,
  outcome?: ReviewOutcome["files"][number]
): string {
  const open = file.insertions + file.deletions <= OPEN_DIFF_MAX_CHURN
  const rename = renamePaths(file)
  const pathHtml = rename
    ? `<span class="old-path">${escapeHtml(rename.from)}</span><span class="rename-arrow">→</span>${
      escapeHtml(rename.to)
    }`
    : escapeHtml(file.path)
  const plainBadge = render.note !== ""
    ? `<span class="badge plain-render" title="${
      render.note === "oversize"
        ? "The diff is too large for the highlighted renderer."
        : "The highlighted renderer failed for this diff."
    }">plain rendering (${render.note === "oversize" ? "large diff" : "renderer failed"})</span>`
    : ""
  const notReviewed = outcome?.status === "not_reviewed"
    ? `<span class="not-reviewed" title="${escapeHtml(outcome.reason)}">not reviewed · ${
      escapeHtml(humanizeExcludeReason(outcome.reason))
    }</span>`
    : !file.reviewed && file.excludeReason
    ? `<span class="not-reviewed" title="${escapeHtml(file.excludeReason)}">not agent-reviewed · ${
      escapeHtml(humanizeExcludeReason(file.excludeReason))
    }</span>`
    : ""
  const head = [
    `<div class="file-head">`,
    `<span class="path">${pathHtml}</span>`,
    `<span class="badge ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>`,
    statChip(file.insertions, file.deletions),
    plainBadge,
    notReviewed,
    `<a class="anchor-link" href="#${anchor}" aria-label="Link to ${escapeHtml(file.path)}">#</a>`,
    `</div>`
  ].join("")
  const bodyClass = render.renderer === "pierre" ? "diff-body pierre-diff" : "diff-body plain-diff"
  // Collapsed large diffs get a size hint so the reader knows what a click
  // costs; open diffs are visible, so a plain "Diff" label is enough.
  const churn = file.insertions + file.deletions
  const sizeHint = churn >= 10_000 ? `~${Math.round(churn / 1_000)}k lines` : `~${churn} lines`
  const summaryLabel = open ? "Diff" : `Diff — large, ${sizeHint}`
  const diff = file.diff.trim()
    ? `<details${
      open ? " open" : ""
    }><summary>${summaryLabel}</summary><div class="${bodyClass}">${render.body}</div></details>`
    : `<div class="${bodyClass}">${render.body}</div>`
  // The auto-generated "status (+x −y)" intro just repeats the head chips;
  // only real narrator intros earn a paragraph.
  const realIntro = intro.trim() !== describeChange(file) ? intro : ""
  return [
    `<article class="file" id="${anchor}" data-path="${escapeHtml(file.path)}">`,
    head,
    realIntro ? `<p class="intro">${renderProseInline(realIntro)}</p>` : "",
    ...findings.map(({ comment, id }) => findingCard(comment, id)),
    diff,
    `</article>`
  ].join("")
}

function diagramSection(block: StoryBlock, index: number): string {
  return [
    `<figure class="diagram" id="diagram-${index}">`,
    `<pre class="mermaid">${escapeHtml(block.mermaid)}</pre>`,
    block.title ? `<figcaption>${escapeHtml(block.title)}</figcaption>` : "",
    `</figure>`
  ].join("")
}

/**
 * Render every file's diff with @pierre/diffs (syntax highlighting,
 * word-level diffs, line numbers), hoisting the shared style/sprite assets so
 * the page carries them once. Binary, oversized, and unparseable diffs fall
 * back to the plain renderer; Pierre failures are logged to stderr instead of
 * being silently swallowed.
 */
async function renderDiffBodies(
  files: Array<ChangedFile>,
  diffStyle: "unified" | "split"
): Promise<{ renders: Map<string, DiffRender>; sprite: string; styles: Array<string> }> {
  const renders = new Map<string, DiffRender>()
  const styles = new Set<string>()
  let sprite = ""
  await Promise.all(
    files.map(async (file) => {
      if (!file.diff.trim()) {
        renders.set(file.path, { body: renderFallbackDiffHtml(file.diff), renderer: "fallback", note: "" })
        return
      }
      if (file.insertions + file.deletions > PIERRE_MAX_CHURN) {
        renders.set(file.path, { body: renderFallbackDiffHtml(file.diff), renderer: "fallback", note: "oversize" })
        return
      }
      try {
        // Pierre's `system` mode declares `color-scheme: light dark` on its
        // own host, which follows the OS even when the walkthrough shell has
        // an explicit `data-theme`. Start from a deterministic light render;
        // walkthroughRestoreCss (emitted after Pierre's styles) switches that
        // host to dark under the same data-theme-wins contract as the shell.
        const html = await renderPierreFileDiff({ diff: file.diff, diffStyle, themeType: "light" })
        const assets = extractDiffAssets(html)
        for (const style of assets.styles) styles.add(style)
        if (!sprite) sprite = assets.sprite
        renders.set(file.path, { body: assets.body, renderer: "pierre", note: "" })
      } catch (error) {
        await Effect.runPromise(
          Effect.logWarning(`[walkthrough] pierre diff renderer failed for ${file.path}; using plain rendering:`, error)
            .pipe(Effect.provideService(Logger.LogToStderr, true))
        )
        renders.set(file.path, { body: renderFallbackDiffHtml(file.diff), renderer: "fallback", note: "error" })
      }
    })
  )
  return { renders, sprite, styles: [...styles] }
}

function findingsChip(comments: Array<ReviewComment>, incomplete: boolean): string {
  if (comments.length === 0) {
    return incomplete
      ? `<span class="chip">findings <strong>unavailable or incomplete</strong></span>`
      : `<span class="chip">findings <strong>0</strong></span>`
  }
  const counts = new Map<string, number>()
  for (const comment of comments) {
    const severity = severityOf(comment)
    counts.set(severity, (counts.get(severity) ?? 0) + 1)
  }
  const breakdown = severityOrder
    .filter((severity) => counts.has(severity))
    .map((severity) => `<span class="sev-count sev-${severity}">${counts.get(severity)} ${severity}</span>`)
    .join(" · ")
  return `<span class="chip">${pluralize(comments.length, "finding")}: ${breakdown}</span>`
}

function reviewNotice(outcome: ReviewOutcome | undefined): string {
  if (!outcome) return ""
  const title = outcome.status === "failed" ?
    "Review failed"
    : outcome.status === "skipped" ?
    "Review skipped"
    : outcome.status !== "success" ?
    "Review incomplete or completed with warnings"
    : outcome.warnings.length > 0 ?
    "Review warnings"
    : "Review completed"
  const incomplete = outcome.status !== "success" || outcome.warnings.length > 0
  const warnings = outcome.warnings.map((warning) =>
    `<li><strong>${escapeHtml(warning.type)}</strong>${
      warning.file ? ` · <code>${escapeHtml(warning.file)}</code>` : ""
    }: ${escapeHtml(warning.message)}</li>`
  ).join("")
  return `<section class="panel review-outcome" data-review-status="${
    escapeHtml(outcome.status)
  }" role="status"><h2>${title}</h2>${
    incomplete
      ? "<p>Findings may be incomplete or unverified. This walkthrough does not establish a clean review.</p>"
      : ""
  }${warnings ? `<ul>${warnings}</ul>` : ""}</section>`
}

function findingsIndexSection(
  comments: Array<ReviewComment>,
  findingIds: Map<ReviewComment, string>,
  orphans: Array<ReviewComment>
): string {
  if (comments.length === 0) return ""
  // Orphan findings (comment.path matches no changed file) have no file card
  // to live in, so their #finding-N anchors would dangle. Render them as full
  // cards here so every index link resolves.
  const orphanHtml = orphans.length > 0
    ? `<div class="orphan-findings"><h3>Findings without a matching file</h3>${
      orphans
        .map(
          (comment) =>
            `<div class="orphan"><code class="orphan-path">${escapeHtml(comment.path)}</code>${
              findingCard(comment, findingIds.get(comment) ?? "")
            }</div>`
        )
        .join("")
    }</div>`
    : ""
  const groups = severityOrder
    .map((severity) => ({ severity, items: comments.filter((comment) => severityOf(comment) === severity) }))
    .filter((group) => group.items.length > 0)
  const groupHtml = groups
    .map((group) => {
      const items = group.items
        .map((comment) => {
          const id = findingIds.get(comment) ?? ""
          const loc = comment.startLine > 0 ? `:${comment.startLine}` : ""
          const summary = comment.content.split("\n")[0]!
          return `<li><a class="finding-link" data-finding-link href="#${id}"><code>${
            escapeHtml(comment.path)
          }</code><span class="loc">${escapeHtml(loc)}</span></a><span class="finding-summary">${
            escapeHtml(summary)
          }</span></li>`
        })
        .join("")
      return `<div class="sev-group sev-${group.severity}"><h3><span class="dot"></span>${group.severity}<span class="toc-count">${group.items.length}</span></h3><ol>${items}</ol></div>`
    })
    .join("")
  return `<section class="panel" id="findings"><h2>Review findings<span class="count-pill">${comments.length}</span></h2>${groupHtml}${orphanHtml}</section>`
}

function sidebarToc(args: {
  story: Story
  anchorByPath: Map<string, string>
  hasFindings: boolean
  mobile?: boolean
}): string {
  const sections: Array<string> = []
  if (args.hasFindings) {
    sections.push(`<div class="toc-title">Review</div>`)
    if (args.hasFindings) sections.push(`<a href="#findings">Findings</a>`)
  }
  if (args.story.chapters.length > 0) {
    sections.push(`<div class="toc-title">Chapters</div>`)
    const MAX_FILE_LINKS = 10
    args.story.chapters.forEach((chapter, index) => {
      sections.push(`<a href="#ch-${index + 1}">${index + 1}. ${escapeHtml(chapter.title)}</a>`)
      const links: Array<string> = []
      for (const block of chapter.blocks) {
        if (block.kind !== "diff") continue
        const anchor = args.anchorByPath.get(block.path)
        if (!anchor) continue
        // Basename-first: the dir prefix is faint and ellipsizes from the
        // left so the discriminating part of the path survives truncation.
        const slash = block.path.lastIndexOf("/")
        const dir = slash >= 0 ? block.path.slice(0, slash + 1) : ""
        const base = slash >= 0 ? block.path.slice(slash + 1) : block.path
        links.push(
          `<a class="toc-file" href="#${anchor}" title="${escapeHtml(block.path)}">${
            dir ? `<span class="toc-dir">${escapeHtml(dir)}</span>` : ""
          }${escapeHtml(base)}</a>`
        )
      }
      if (links.length > MAX_FILE_LINKS) {
        const hidden = links.length - MAX_FILE_LINKS
        links.length = MAX_FILE_LINKS
        links.push(`<a class="toc-file toc-more" href="#ch-${index + 1}">+${hidden} more</a>`)
      }
      sections.push(...links)
    })
  }
  if (sections.length === 0) return ""
  return `<nav class="toc${args.mobile ? " toc-mobile" : ""}" aria-label="Contents">${sections.join("")}</nav>`
}

/**
 * Self-contained HTML walkthrough in story form: chapters are streams of
 * prose, diagrams, and diffs, so the explanation IS the document and each
 * diff appears at the point in the story where the reader needs it. Pierre
 * renders the diffs; Mermaid renders narrator diagrams (gzipped runtime
 * inlined only when diagrams exist); a deterministic chart of plain HTML bars
 * shows the change shape.
 * Light and dark via the shared data-theme-wins contract with a persisted
 * theme toggle. No external assets; opens from file://.
 */
export async function renderWalkthroughHtml(opts: {
  title: string
  story: Story
  files: Array<ChangedFile>
  comments: Array<ReviewComment>
  outcome?: ReviewOutcome
  repoDir: string
  mode: string
  ref: string
  generatedAt: string
  diffStyle?: "unified" | "split"
}): Promise<string> {
  const { story, files, comments } = opts
  const outcomeByPath = new Map(opts.outcome?.files.map((file) => [file.path, file]))
  const title = opts.title.trim() || story.headline || "Change walkthrough"
  const fileByPath = new Map(files.map((file) => [file.path, file]))
  const anchorByPath = new Map(files.map((file, index) => [file.path, `file-${index + 1}`]))
  const findingIds = new Map(comments.map((comment, index) => [comment, `finding-${index + 1}`] as const))
  const commentsByPath = new Map<string, Array<{ comment: ReviewComment; id: string }>>()
  for (const comment of comments) {
    const entry = { comment, id: findingIds.get(comment) ?? "" }
    commentsByPath.set(comment.path, [...(commentsByPath.get(comment.path) ?? []), entry])
  }

  const { renders, sprite, styles } = await renderDiffBodies(files, opts.diffStyle ?? "unified")

  const totalInsertions = files.reduce((sum, file) => sum + file.insertions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const hasDiagrams = story.chapters.some((chapter) => chapter.blocks.some((block) => block.kind === "diagram"))
  const repoName = opts.repoDir.replace(/\/+$/, "").split("/").pop() || opts.repoDir

  const orphanComments = comments.filter((comment) => !fileByPath.has(comment.path))
  const findingsIndex = findingsIndexSection(comments, findingIds, orphanComments)
  const chips = [
    `<span class="chip" title="${escapeHtml(opts.repoDir)}">repo <strong><code>${
      escapeHtml(repoName)
    }</code></strong></span>`,
    `<span class="chip">target <strong>${escapeHtml(opts.mode)}${
      opts.ref && opts.ref !== "workspace" ? ` ${escapeHtml(opts.ref)}` : ""
    }</strong></span>`,
    `<span class="chip"><strong>${escapeHtml(pluralize(files.length, "file"))}</strong></span>`,
    `<span class="chip add"><strong>+${totalInsertions}</strong></span>`,
    `<span class="chip del"><strong>−${totalDeletions}</strong></span>`,
    findingsChip(
      comments,
      opts.outcome !== undefined && (opts.outcome.status !== "success" || opts.outcome.warnings.length > 0)
    ),
    `<span class="chip" title="${escapeHtml(opts.generatedAt)}">generated <strong>${
      escapeHtml(formatUtcTimestamp(opts.generatedAt))
    }</strong></span>`
  ].join("")

  const toc = story.chapters.length > 0
    ? `<section class="panel toc-panel" id="chapters"><h2>Chapters</h2><ol>${
      story.chapters
        .map((chapter, index) => {
          const diffCount = chapter.blocks.filter((block) => block.kind === "diff").length
          return `<li><a href="#ch-${index + 1}">${escapeHtml(chapter.title)}</a> <span class="stat">(${
            escapeHtml(pluralize(diffCount, "file"))
          })</span></li>`
        })
        .join("")
    }</ol></section>`
    : `<section class="panel empty-state" id="chapters"><div class="empty-glyph">✦</div><h2>No changes detected</h2><p>The review target has no changed files, so there is nothing to walk through. Re-run against a different ref, commit, or range to see a story here.</p></section>`

  let diagramIndex = 0
  const chapters = story.chapters
    .map((chapter, index) => {
      const blocks = chapter.blocks
        .map((block) => {
          if (block.kind === "diff") {
            const file = fileByPath.get(block.path)
            if (!file) return ""
            return diffSection(
              file,
              block.intro,
              commentsByPath.get(block.path) ?? [],
              anchorByPath.get(block.path) ?? "",
              renders.get(block.path) ?? { body: renderFallbackDiffHtml(file.diff), renderer: "fallback", note: "" },
              outcomeByPath.get(block.path)
            )
          }
          if (block.kind === "diagram") {
            diagramIndex += 1
            return diagramSection(block, diagramIndex)
          }
          return `<div class="prose">${renderProse(block.text)}</div>`
        })
        .join("")
      return [
        `<section class="chapter" id="ch-${index + 1}">`,
        `<h2><span class="num">${index + 1}</span>${escapeHtml(chapter.title)}<a class="anchor-link" href="#ch-${
          index + 1
        }" aria-label="Link to chapter ${index + 1}">#</a></h2>`,
        blocks,
        `</section>`
      ].join("")
    })
    .join("")

  const mermaidScripts = hasDiagrams
    ? [
      `<script type="text/plain" id="mermaid-runtime-gz">${mermaidRuntimeGzipBase64()}</script>`,
      `<script>${mermaidLoaderScript}</script>`
    ]
    : []

  const description = (story.synopsis || title).slice(0, 300)

  // Applied before the stylesheet so a persisted light/dark choice can't
  // flash the system theme first. Key must match THEME_STORAGE in
  // walkthroughScript.ts.
  const themeBootScript =
    `<script>try{var t=localStorage.getItem("smithers-review-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`

  const tocArgs = { story, anchorByPath, hasFindings: comments.length > 0 }
  const mobileTocNav = sidebarToc({ ...tocArgs, mobile: true })
  const mobileToc = mobileTocNav
    ? `<details class="mobile-toc"><summary>Contents</summary>${mobileTocNav}</details>`
    : ""

  const footer = [
    `<footer>`,
    `<div class="footer-meta"><span class="wordmark">smithers review</span> · generated ${
      escapeHtml(formatUtcTimestamp(opts.generatedAt))
    }</div>`,
    `<div class="kbd-hint"><kbd>j</kbd>/<kbd>k</kbd> files · <kbd>x</kbd> toggle diff</div>`,
    `</footer>`
  ].join("")

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="icon" href="${faviconSvg}">`,
    `<title>${escapeHtml(title)}</title>`,
    themeBootScript,
    `<style>${walkthroughCss}</style>`,
    ...styles,
    `<style>${walkthroughRestoreCss}</style>`,
    `</head>`,
    `<body>`,
    sprite,
    `<div class="progress" aria-hidden="true"><div class="progress-fill"></div></div>`,
    `<div class="layout">`,
    sidebarToc(tocArgs),
    `<main>`,
    `<header class="page">`,
    `<div class="masthead">`,
    `<div>`,
    `<h1>${escapeHtml(title)}</h1>`,
    story.synopsis ? `<p class="synopsis">${escapeHtml(story.synopsis)}</p>` : "",
    `</div>`,
    `<button id="theme-toggle" type="button" class="theme-toggle" aria-label="Cycle color theme">◐ Auto</button>`,
    `</div>`,
    renderOverviewChart(files),
    `<div class="meta">${chips}<span class="controls"><button id="expand-all" type="button">Expand all diffs</button><button id="collapse-all" type="button">Collapse all diffs</button></span></div>`,
    `</header>`,
    reviewNotice(opts.outcome),
    mobileToc,
    findingsIndex,
    toc,
    chapters,
    footer,
    `</main>`,
    `</div>`,
    `<script>${walkthroughScript}</script>`,
    ...mermaidScripts,
    `</body>`,
    `</html>`
  ].join("\n")
}
