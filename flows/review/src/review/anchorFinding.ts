import type { ReviewComment } from "../workflow/reviewCommentSchema.ts"

type HunkLine = {
  type: "context" | "added" | "deleted"
  content: string
}

type Hunk = {
  oldStart: number
  newStart: number
  lines: Array<HunkLine>
}

type IndexedLine = {
  lineNum: number
  content: string
}

function parseHunks(diffText: string): Array<Hunk> {
  const hunks: Array<Hunk> = []
  let current: Hunk | null = null
  for (const line of diffText.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }
      hunks.push(current)
      continue
    }
    // File headers precede the first hunk; inside a hunk every diff marker is code.
    if (!current) continue
    if (line.startsWith("+")) {
      current.lines.push({ type: "added", content: line.slice(1) })
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "deleted", content: line.slice(1) })
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", content: line.slice(1) })
    }
  }
  return hunks
}

function normalizeCodeLine(value: string) {
  return value.trim().replace(/^[+-]/, "").trim()
}

function splitAndNormalizeCode(value: string) {
  return value.split("\n").map(normalizeCodeLine).filter(Boolean)
}

function extractSideLines(hunk: Hunk, newSide: boolean): Array<IndexedLine> {
  const result: Array<IndexedLine> = []
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  for (const line of hunk.lines) {
    if (line.type === "context") {
      result.push({
        lineNum: newSide ? newLine : oldLine,
        content: normalizeCodeLine(line.content)
      })
      oldLine += 1
      newLine += 1
    } else if (line.type === "added") {
      if (newSide) result.push({ lineNum: newLine, content: normalizeCodeLine(line.content) })
      newLine += 1
    } else {
      if (!newSide) result.push({ lineNum: oldLine, content: normalizeCodeLine(line.content) })
      oldLine += 1
    }
  }
  return result
}

function collectMatches(sideLines: Array<IndexedLine>, targetLines: Array<string>) {
  const matches: Array<{ startLine: number; endLine: number }> = []
  if (targetLines.length === 0 || sideLines.length < targetLines.length) return matches
  for (let i = 0; i <= sideLines.length - targetLines.length; i += 1) {
    let matched = true
    for (let j = 0; j < targetLines.length; j += 1) {
      if (sideLines[i + j]!.content !== targetLines[j]) {
        matched = false
        break
      }
    }
    if (matched) {
      matches.push({
        startLine: sideLines[i]!.lineNum,
        endLine: sideLines[i + targetLines.length - 1]!.lineNum
      })
    }
  }
  return matches
}

function newSideHunkRanges(hunks: Array<Hunk>) {
  return hunks
    .map((hunk) => {
      const newSideCount = hunk.lines.filter((line) => line.type !== "deleted").length
      return { start: hunk.newStart, end: hunk.newStart + Math.max(newSideCount - 1, 0) }
    })
    .filter((range) => range.start > 0)
}

function withinNewSideRanges(hunks: Array<Hunk>, startLine: number, endLine: number) {
  return newSideHunkRanges(hunks).some((range) => startLine >= range.start && endLine <= range.end)
}
/**
 * Pins findings to new-side lines, or keeps them unanchored when their snippet
 * exists only on the old side. Old-side coordinates must never become a
 * replacement range for an applicable GitHub suggestion.
 */
export function anchorFinding(comment: ReviewComment, diffText: string) {
  const hunks = parseHunks(diffText)
  const targetLines = splitAndNormalizeCode(comment.existingCode)
  const matches = hunks.flatMap((hunk) => collectMatches(extractSideLines(hunk, true), targetLines))
  if (
    matches.length === 0 && hunks.some((hunk) => collectMatches(extractSideLines(hunk, false), targetLines).length > 0)
  ) {
    // Preserve deleted-side provenance as an unanchored finding, even when the
    // reviewer supplied an otherwise valid new-side line number.
    return { ...comment, startLine: 0, endLine: 0 }
  }
  const startLine = comment.startLine > 0 ? comment.startLine : comment.endLine
  const endLine = Math.max(comment.endLine, startLine)
  if (startLine > 0 && withinNewSideRanges(hunks, startLine, endLine)) {
    return { ...comment, startLine, endLine }
  }
  // Only a unique new-side match can resolve a missing or out-of-range anchor.
  if (matches.length === 1) return { ...comment, ...matches[0] }
  return { ...comment, startLine: 0, endLine: 0 }
}
