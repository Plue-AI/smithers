#!/usr/bin/env node
// Fails when a main run has a red target nobody owns. Reads the run's log on
// stdin, takes every target the known-red verdict printed as failed ("newly
// red" or "known red"), and reports each one neither excused by a live
// `.github/ci-known-red.json` entry for the platform nor named, as a whole
// label, in an open issue title.
//
//   gh run view <run> --log | node scripts/ci/check-known-red-coverage.mjs
//
// `--issues <file>` reads `gh issue list --json title,state` output instead of
// calling gh. Exit 1 lists the unowned targets; exit 2 means the inputs could
// not be read, never an empty owner list.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { parse } from "../../packages/smithers/build/build-cli/src/KnownRed.ts"

const verdictLine = /(?:newly red, no matching failure in [^:]+|known red \([^)]*\)): (\/\/\S+)\s*$/
const labelCharacter = /[\w./@+:-]/

export const failedTargets = (log) => [
  ...new Set(log.split("\n").flatMap((line) => {
    const match = verdictLine.exec(line)
    return match === null ? [] : [match[1]]
  }))
]

const names = (title, label) => {
  for (let at = title.indexOf(label); at !== -1; at = title.indexOf(label, at + 1)) {
    const before = title[at - 1]
    const after = title[at + label.length]
    if ((before === undefined || !labelCharacter.test(before)) && (after === undefined || !labelCharacter.test(after))) {
      return true
    }
  }
  return false
}

// Platform and expiry follow KnownRed.judge: an entry without `platforms`
// applies everywhere, and `expires` is the last UTC day it holds.
export const uncovered = ({ failed, entries, issues, platform, today }) => {
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue?.title !== "string" || typeof issue?.state !== "string")) {
    throw new Error("the issue list must be an array of { title, state }")
  }
  const excused = new Set(entries
    .filter((entry) => entry.platforms === undefined || entry.platforms.includes(platform))
    .filter((entry) => entry.expires >= today)
    .map((entry) => entry.label))
  const titles = issues.filter((issue) => issue.state.toUpperCase() === "OPEN").map((issue) => issue.title)
  return failed.filter((label) => !excused.has(label) && !titles.some((title) => names(title, label)))
}

const openIssues = (repository) => {
  const result = spawnSync("gh", ["issue", "list", "--repo", repository, "--state", "open", "--limit", "5000", "--json", "title,state"], {
    encoding: "utf8"
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`gh issue list failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}

const main = () => {
  const { values } = parseArgs({
    options: {
      "known-red": { type: "string", default: ".github/ci-known-red.json" },
      issues: { type: "string" },
      repo: { type: "string", default: "smithersai/smithers" },
      platform: { type: "string", default: "linux" },
      today: { type: "string", default: new Date().toISOString().slice(0, 10) }
    }
  })
  let failed, entries, issues
  try {
    failed = failedTargets(readFileSync(0, "utf8"))
    entries = parse(values["known-red"], readFileSync(values["known-red"], "utf8"))
    issues = values.issues === undefined ? openIssues(values.repo) : JSON.parse(readFileSync(values.issues, "utf8"))
    const unowned = uncovered({ failed, entries, issues, platform: values.platform, today: values.today })
    for (const label of unowned) process.stderr.write(`no owner: ${label}\n`)
    process.stderr.write(`${failed.length} red targets, ${unowned.length} without an owner\n`)
    process.exitCode = unowned.length === 0 ? 0 : 1
  } catch (cause) {
    process.stderr.write(`check-known-red-coverage: ${cause.message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
