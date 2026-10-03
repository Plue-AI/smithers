import { fenceFor } from "../text/fenceFor.ts"
import { pluralize } from "../text/pluralize.ts"
import type { Story } from "../walkthrough/storySchema.ts"
import { ReviewCommentSeverity } from "../workflow/reviewCommentSeveritySchema.ts"
import type { ReviewRunOutput } from "../workflow/reviewRunOutputSchema.ts"
import type { PullRequestFile } from "./listPullRequestFiles.ts"

type Finding = ReviewRunOutput["comments"][number]
type Severity = Finding["severity"]
type Warning = { file: string; message: string; type: string }

export type PullRequestReviewPayload = {
  commit_id: string
  event: "COMMENT"
  body: string
  comments: Array<{
    path: string
    line: number
    side: "RIGHT"
    start_line?: number
    start_side?: "RIGHT"
    body: string
  }>
}

const MAX_BODY_CHARS = 60_000
const MAX_FILES_PER_CHAPTER = 30
const MAX_FILE_TABLE_ROWS = 30

const SEVERITY_ORDER = ReviewCommentSeverity.literals
const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "💥",
  major: "🔴",
  minor: "🟡",
  info: "ℹ️"
}

function findingBody(finding: Finding, degradedAnchor: boolean): string {
  const parts = [
    `${SEVERITY_EMOJI[finding.severity]} **${finding.severity}** · ${finding.category}`,
    "",
    finding.content
  ]
  if (finding.suggestionCode) {
    const fence = fenceFor(finding.suggestionCode)
    if (degradedAnchor) {
      // The anchor collapsed to a single line, so a ```suggestion block would
      // replace the wrong range on "Apply suggestion" and corrupt the file.
      parts.push(
        "",
        `Suggested replacement for lines ${finding.startLine}–${finding.endLine}:`,
        "",
        fence,
        finding.suggestionCode,
        fence
      )
    } else {
      parts.push("", `${fence}suggestion`, finding.suggestionCode, fence)
    }
  }
  return parts.join("\n")
}

function unanchoredLine(finding: Finding): string {
  const loc = finding.startLine > 0 ? `:${finding.startLine}` : ""
  return `- ${SEVERITY_EMOJI[finding.severity]} \`${finding.path}${loc}\` (${finding.category}) — ${
    finding.content.split("\n").join(" ")
  }`
}

function severityBreakdown(findings: Array<Finding>): string {
  const parts: Array<string> = []
  for (const severity of SEVERITY_ORDER) {
    const count = findings.filter((finding) => finding.severity === severity).length
    if (count > 0) parts.push(`${SEVERITY_EMOJI[severity]} ${count} ${severity}`)
  }
  return parts.join(" · ")
}

/**
 * Whether a finding can anchor inline against the PR's actual diff. GitHub
 * rejects the whole review batch when any comment's line is not part of a
 * diff hunk, so a finding only anchors when its line(s) are commentable;
 * multi-line ranges degrade to the end line when the range does not fully
 * sit inside the diff.
 */
function anchorFor(
  finding: Finding,
  prFiles: Map<string, PullRequestFile>
): { line: number; startLine?: number; degraded: boolean } | null {
  const file = prFiles.get(finding.path)
  if (!file || finding.startLine <= 0) return null
  const lines = file.commentableLines
  const endLine = finding.endLine >= finding.startLine ? finding.endLine : finding.startLine
  if (!lines.has(endLine)) return null
  if (endLine > finding.startLine) {
    let rangeOk = true
    for (let line = finding.startLine; line <= endLine; line += 1) {
      if (!lines.has(line)) {
        rangeOk = false
        break
      }
    }
    if (rangeOk) return { line: endLine, startLine: finding.startLine, degraded: false }
    // The multi-line range collapsed to its end line.
    return { line: endLine, degraded: true }
  }
  return { line: endLine, degraded: false }
}

/**
 * Compose one PR review from the story and findings: a narrative body
 * (headline, synopsis, severity groups, file table, reading order,
 * walkthrough link) plus inline comments for every finding that anchors into
 * the PR's actual diff. Findings that cannot anchor are grouped by severity
 * in the body (minor and below collapsed), so nothing is dropped. When the
 * review degraded (failed file reviews), the body says so instead of reading
 * like a clean pass.
 */
export function buildPullRequestReview(args: {
  story: Story
  findings: Array<Finding>
  prFiles: Map<string, PullRequestFile>
  headSha: string
  walkthroughUrl?: string
  reviewStatus?: string
  warnings?: Array<Warning>
}): PullRequestReviewPayload {
  const anchored: PullRequestReviewPayload["comments"] = []
  const unanchored: Array<Finding> = []
  for (const finding of args.findings) {
    const anchor = anchorFor(finding, args.prFiles)
    if (anchor) {
      anchored.push({
        path: finding.path,
        line: anchor.line,
        side: "RIGHT",
        ...(anchor.startLine != null ? { start_line: anchor.startLine, start_side: "RIGHT" as const } : {}),
        body: findingBody(finding, anchor.degraded)
      })
    } else {
      unanchored.push(finding)
    }
  }

  const warnings = args.warnings ?? []
  const failedFileReviews = warnings.filter((warning) => warning.type === "subtask_error").length
  const degraded = args.reviewStatus === "failed" || failedFileReviews > 0

  const lines: Array<string> = ["<!-- smithers-review -->"]
  lines.push(`## smithers review — ${args.story.headline || "change walkthrough"}`)
  if (args.story.synopsis) lines.push("", args.story.synopsis)
  if (args.walkthroughUrl) lines.push("", `**📖 Full walkthrough:** ${args.walkthroughUrl}`)

  if (degraded) {
    const detail = failedFileReviews > 0
      ? `${pluralize(failedFileReviews, "file review")} failed`
      : "the review agents failed"
    lines.push(
      "",
      `> ⚠️ **Review degraded:** ${detail}; findings may be incomplete. Do not treat this as a clean pass.`
    )
  }

  if (args.findings.length > 0) {
    lines.push("", `### Findings: ${severityBreakdown(args.findings)}`)
  }

  if (unanchored.length > 0) {
    lines.push("", `### ${pluralize(unanchored.length, "finding")} without an inline anchor`)
    for (const severity of SEVERITY_ORDER) {
      const group = unanchored.filter((finding) => finding.severity === severity)
      if (group.length === 0) continue
      if (severity === "minor" || severity === "info") {
        lines.push(
          "",
          "<details>",
          `<summary>${SEVERITY_EMOJI[severity]} ${severity} (${group.length})</summary>`,
          "",
          ...group.map(unanchoredLine),
          "",
          "</details>"
        )
      } else {
        lines.push(
          "",
          `**${SEVERITY_EMOJI[severity]} ${severity} (${group.length})**`,
          "",
          ...group.map(unanchoredLine)
        )
      }
    }
  }

  if (args.prFiles.size > 0) {
    const findingsByPath = new Map<string, number>()
    for (const finding of args.findings) {
      findingsByPath.set(finding.path, (findingsByPath.get(finding.path) ?? 0) + 1)
    }
    const rows = [...args.prFiles.values()]
    const shown = rows.slice(0, MAX_FILE_TABLE_ROWS)
    lines.push("", "### Files", "", "| File | +/- | Findings |", "| --- | --- | --- |")
    for (const file of shown) {
      const count = findingsByPath.get(file.filename) ?? 0
      lines.push(`| \`${file.filename}\` | +${file.additions} −${file.deletions} | ${count > 0 ? count : ""} |`)
    }
    const hidden = rows.length - shown.length
    if (hidden > 0) lines.push("", `…and ${pluralize(hidden, "more file")}.`)
  }

  if (args.story.chapters.length > 0) {
    lines.push("", "### Reading order")
    args.story.chapters.forEach((chapter, index) => {
      lines.push("", `**${index + 1}. ${chapter.title}**`)
      const firstProse = chapter.blocks.find((block) => block.kind === "prose")
      if (firstProse?.text) {
        const summary = firstProse.text.split("\n\n")[0]!
        lines.push("", summary.length > 400 ? `${summary.slice(0, 400)}…` : summary)
      }
      const diffBlocks = chapter.blocks.filter((block) => block.kind === "diff")
      const shown = diffBlocks.slice(0, MAX_FILES_PER_CHAPTER)
      for (const block of shown) {
        lines.push(`- \`${block.path}\`${block.intro ? ` — ${block.intro}` : ""}`)
      }
      const hidden = diffBlocks.length - shown.length
      if (hidden > 0) lines.push(`- …and ${pluralize(hidden, "more file")}`)
      const diagrams = chapter.blocks.filter((block) => block.kind === "diagram").length
      if (diagrams > 0) lines.push(`- 📊 ${pluralize(diagrams, "diagram")} in the full walkthrough`)
    })
  }

  const footerParts = [`${pluralize(args.findings.length, "finding")} · ${anchored.length} inline`]
  if (degraded) footerParts.push(`⚠️ ${pluralize(failedFileReviews, "file review")} failed`)
  else if (args.reviewStatus === "completed_with_warnings") {
    footerParts.push("⚠️ completed with warnings; see the run log")
  }
  footerParts.push("generated by smithers review")
  lines.push("", `_${footerParts.join(" · ")}_`)

  let body = lines.join("\n")
  if (body.length > MAX_BODY_CHARS) {
    // Cut at a section boundary (blank line) so the truncation cannot land
    // inside a table or code fence.
    const slice = body.slice(0, MAX_BODY_CHARS)
    const boundary = slice.lastIndexOf("\n\n")
    const kept = boundary > 0 ? slice.slice(0, boundary) : slice
    // A blank line can still sit *inside* an open <details> (the
    // minor/info groups push blank lines between <summary> and </details>), so
    // close any disclosures still open in the kept slice — otherwise GitHub
    // renders the truncation notice (and everything after) collapsed and hidden.
    const openDetails = (kept.match(/<details>/g)?.length ?? 0) - (kept.match(/<\/details>/g)?.length ?? 0)
    const parts = [kept]
    for (let i = 0; i < openDetails; i += 1) parts.push("</details>")
    parts.push("", "_…truncated; see the full walkthrough._")
    body = parts.join("\n")
  }

  return { commit_id: args.headSha, event: "COMMENT", body, comments: anchored }
}
