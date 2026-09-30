#!/usr/bin/env node
/**
 * Fails when a tracked text file holds a committed merge-conflict marker.
 *
 * 50009960df and a1db0f6fe7 committed jj conflict blocks into three test
 * files, which then failed to parse. Both git's markers (`<<<<<<<`,
 * `|||||||`, `>>>>>>>`) and jj's (`<<<<<<< conflict 1 of 1`, `%%%%%%%`,
 * `\\\\\\\`, `+++++++`, `-------`, `>>>>>>> conflict 1 of 1 ends`) are
 * caught: a marker is exactly seven marker characters at the start of a line,
 * followed by a space or the end of the line. `=======` alone is not a marker
 * here, since Markdown uses it as a heading underline; a git conflict always
 * carries `<<<<<<<` and `>>>>>>>` too.
 *
 * `git grep -I` searches the tracked files as they stand in the working tree
 * and skips binary files.
 *
 * Usage: node scripts/check-conflict-markers.mjs [repository root]
 * Exits 0 when clean, 1 on a marker, and 2 when the search itself failed.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/** The extended regular expression for one marker line, shared with git grep. */
export const markerPattern = "^(<<<<<<<|>>>>>>>|\\|\\|\\|\\|\\|\\|\\||%%%%%%%|\\\\\\\\\\\\\\\\\\\\\\\\\\\\|\\+\\+\\+\\+\\+\\+\\+|-------)( |$)"

const markerLine = new RegExp(markerPattern)

/** Whether one line of text is a conflict marker. */
export const isMarkerLine = (line) => markerLine.test(line)

/**
 * The marker lines in the tracked text files under `root`, as
 * `{ path, line, text }`, in git's order.
 */
export const findConflictMarkers = (root) => {
  const result = spawnSync("git", ["grep", "-z", "-n", "-I", "-E", "-e", markerPattern, "--"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error !== undefined) throw new Error(`git grep could not run: ${result.error.message}`)
  // git grep exits 1 when nothing matches and 0 when something does.
  if (result.status === 1 && result.stdout === "") return []
  if (result.status !== 0) {
    throw new Error(`git grep failed with status ${result.status}: ${result.stderr.trim()}`)
  }
  const found = []
  for (const record of result.stdout.split("\n")) {
    if (record === "") continue
    const [path, line, ...text] = record.split("\0")
    found.push({ path, line: Number(line), text: text.join("\0") })
  }
  return found
}

const main = () => {
  const root = process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url))
  let found
  try {
    found = findConflictMarkers(root)
  } catch (error) {
    // Exit 2, not 1: a failed search is not a clean tree and not a finding.
    console.error(`conflict markers: ${error.message}`)
    return 2
  }
  if (found.length === 0) {
    console.log("conflict markers: none in tracked files")
    return 0
  }
  for (const { path, line, text } of found) console.error(`${path}:${line}: conflict marker: ${text}`)
  const files = new Set(found.map(({ path }) => path)).size
  console.error(`conflict markers: ${found.length} marker line(s) in ${files} tracked file(s); resolve them`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
