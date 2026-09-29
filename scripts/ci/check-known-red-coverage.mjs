#!/usr/bin/env node
// Fails when a main run has a red target nobody owns. Reads the run's log on
// stdin, takes every target the known-red verdict printed as failed ("newly
// red" or "known red"), and reports each one neither excused by a live
// `.github/ci-known-red.json` entry for the platform nor named, as a whole
// label, in an open issue title. A run mixes Linux, macOS and Windows jobs, so
// each red is judged on the platform of the job that printed it: the job
// column of `gh run view --log` names `(windows-…)` or `(macos-…)`, and any
// other line takes `--platform`.
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
import { parse } from "@smthrs/build-cli/KnownRed"

const verdictLine = /(?:newly red, no matching failure in [^:]+|known red \([^)]*\)): (\/\/\S+)\s*$/
const labelCharacter = /[\w./@+:-]/

const jobPlatform = (line, fallback) => {
  const tab = line.indexOf("\t")
  const job = tab === -1 ? "" : line.slice(0, tab)
  if (/\(windows-/.test(job)) return "win32"
  if (/\(macos-/.test(job)) return "darwin"
  return fallback
}

export const failedTargets = (log, platform = "linux") => {
  const seen = new Map()
  for (const line of log.split("\n")) {
    const match = verdictLine.exec(line)
    if (match === null) continue
    const red = { label: match[1], platform: jobPlatform(line, platform) }
    seen.set(`${red.platform} ${red.label}`, red)
  }
  return [...seen.values()]
}

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
export const uncovered = ({ failed, entries, issues, today }) => {
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue?.title !== "string" || typeof issue?.state !== "string")) {
    throw new Error("the issue list must be an array of { title, state }")
  }
  const live = entries.filter((entry) => entry.expires >= today)
  const excused = ({ label, platform }) =>
    live.some((entry) => entry.label === label && (entry.platforms === undefined || entry.platforms.includes(platform)))
  const titles = issues.filter((issue) => issue.state.toUpperCase() === "OPEN").map((issue) => issue.title)
  return failed.filter((red) => !excused(red) && !titles.some((title) => names(title, red.label)))
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
    failed = failedTargets(readFileSync(0, "utf8"), values.platform)
    entries = parse(values["known-red"], readFileSync(values["known-red"], "utf8"))
    issues = values.issues === undefined ? openIssues(values.repo) : JSON.parse(readFileSync(values.issues, "utf8"))
    const unowned = uncovered({ failed, entries, issues, today: values.today })
    for (const red of unowned) process.stderr.write(`no owner: ${red.label} (${red.platform})\n`)
    process.stderr.write(`${failed.length} red targets, ${unowned.length} without an owner\n`)
    process.exitCode = unowned.length === 0 ? 0 : 1
  } catch (cause) {
    process.stderr.write(`check-known-red-coverage: ${cause.message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
