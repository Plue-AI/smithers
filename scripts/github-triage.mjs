#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import process from "node:process"
import { isMain } from "./workspace-packages.mjs"

export const LABELS = Object.freeze({
  "kind:bug": ["d73a4a", "A reproducible defect"],
  "kind:enhancement": ["a2eeef", "A product improvement"],
  "kind:docs": ["0075ca", "Documentation"],
  "kind:question": ["d876e3", "A support or usage question"],
  "area:cli": ["bfdadc", "Command-line interface"],
  "area:engine": ["bfdadc", "Flow engine and durability"],
  "area:agent": ["bfdadc", "Agent runtime"],
  "area:build": ["bfdadc", "Build graph and targets"],
  "area:ui": ["bfdadc", "User interface"],
  "area:docs": ["bfdadc", "Documentation sites"],
  "area:infrastructure": ["bfdadc", "CI, deployment, or operations"],
  "status:needs-author": ["fbca04", "Waiting for specific information from the author"],
  "status:reproduced": ["0e8a16", "Maintainers have a minimal reproduction"],
  "status:ready-for-review": ["0e8a16", "Intake checks are complete"],
  "pr:missing-tests": ["fbca04", "Behavior changes need focused tests"],
  "pr:missing-docs": ["fbca04", "Public behavior needs documentation"],
  "pr:size-large": ["fbca04", "The change needs to be split or reviewed in stages"]
})

const REPORT_PATH = ".triage/report.json"
const CONTEXT_PATH = ".triage/context.json"
const MAX_PATCH_BYTES = 180_000
const CHECK = new Set(["pass", "needs-work", "not-applicable"])

const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value, maximum = 60_000) => typeof value === "string" && value.trim() && value.length <= maximum

export function validateReport(value, expectedKind) {
  if (!object(value) || value.kind !== expectedKind || !text(value.summary, 500) || !text(value.comment)) return null
  if (!Array.isArray(value.labels) || value.labels.length > 5) return null
  const labels = [...new Set(value.labels)]
  if (labels.some((label) => typeof label !== "string" || !(label in LABELS))) return null

  if (expectedKind === "issue") {
    if (!object(value.reproduction)) return null
    if (!["reproduced", "needs-author", "not-applicable"].includes(value.reproduction.status)) return null
    if (!text(value.reproduction.details, 10_000)) return null
    if (value.reproduction.status === "reproduced" && !labels.includes("status:reproduced")) return null
    if (value.reproduction.status === "needs-author" && !labels.includes("status:needs-author")) return null
  } else {
    if (!object(value.checks)) return null
    if (!["description", "tests", "docs", "size"].every((key) => CHECK.has(value.checks[key]))) return null
    const ready = Object.values(value.checks).every((result) => result !== "needs-work")
    if (labels.includes("status:ready-for-review") !== ready) return null
  }
  return { ...value, labels }
}

export function fallbackReport(kind, reason) {
  const escaped = String(reason).replaceAll("`", "'").slice(0, 500)
  if (kind === "issue") {
    return {
      kind,
      summary: "Automated triage needs help from the issue opener.",
      comment: "I couldn't produce a reliable minimal reproduction in this run. Please add the exact Smithers version or commit, operating system and runtime versions, the smallest command or flow that fails, the full error text, and what you expected instead.\n\n" +
        `Automation detail: \`${escaped}\``,
      labels: ["status:needs-author"],
      reproduction: { status: "needs-author", details: "The automated report was missing or invalid." }
    }
  }
  return {
    kind,
    summary: "Automated pull-request triage could not complete.",
    comment: "I couldn't produce a reliable readiness report in this run. Please make sure the PR description states the intended behavior and links its focused tests; a maintainer can then retry triage.\n\n" +
      `Automation detail: \`${escaped}\``,
    labels: ["status:needs-author"],
    checks: { description: "needs-work", tests: "not-applicable", docs: "not-applicable", size: "not-applicable" }
  }
}

const api = async (path, options = {}) => {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error("GH_TOKEN is required")
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "smithers-triage",
      ...(options.headers ?? {})
    }
  })
  if (!response.ok) throw new Error(`GitHub ${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

// The triggering event names the one issue or PR this run may write to. apply
// reads it again instead of trusting .triage/context.json, which sits in the
// tree the triage flow and the tests it runs can rewrite.
async function readSubject(kind, eventPath) {
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required")
  const event = JSON.parse(await readFile(eventPath, "utf8"))
  const repository = process.env.GITHUB_REPOSITORY ?? event.repository?.full_name
  if (!repository) throw new Error("GITHUB_REPOSITORY is required")
  const subject = kind === "issue" ? event.issue : event.pull_request
  if (!object(subject) || !Number.isSafeInteger(subject.number)) throw new Error(`event has no ${kind}`)
  return { repository, subject }
}

export async function prepare(kind, eventPath = process.env.GITHUB_EVENT_PATH) {
  const { repository, subject } = await readSubject(kind, eventPath)

  let comments = []
  if (kind === "issue") {
    for (let page = 1; page <= 3; page++) {
      const rows = await api(`/repos/${repository}/issues/${subject.number}/comments?per_page=100&page=${page}`)
      comments.push(...rows.map((row) => ({ author: row.user?.login ?? "unknown", body: row.body ?? "", createdAt: row.created_at })))
      if (rows.length < 100) break
    }
  }
  let files = []
  if (kind === "pr") {
    const rows = await api(`/repos/${repository}/pulls/${subject.number}/files?per_page=100`)
    let remaining = MAX_PATCH_BYTES
    files = rows.map((row) => {
      const patch = typeof row.patch === "string" ? row.patch.slice(0, remaining) : ""
      remaining -= patch.length
      return { filename: row.filename, status: row.status, additions: row.additions, deletions: row.deletions, patch }
    })
  }
  const context = {
    kind,
    repository,
    number: subject.number,
    author: subject.user?.login ?? "unknown",
    title: subject.title ?? "",
    body: subject.body ?? "",
    ...(kind === "issue" ? { comments } : {}),
    ...(kind === "pr" ? { draft: subject.draft === true, changedFiles: subject.changed_files ?? files.length, files } : {}),
    allowedLabels: Object.keys(LABELS)
  }
  await mkdir(".triage", { recursive: true })
  await writeFile(CONTEXT_PATH, `${JSON.stringify(context, null, 2)}\n`)
  return context
}

const ensureLabel = async (repository, name) => {
  const [color, description] = LABELS[name]
  const encoded = encodeURIComponent(name)
  try {
    await api(`/repos/${repository}/labels/${encoded}`)
  } catch (cause) {
    if (!String(cause).includes(": 404 ")) throw cause
    await api(`/repos/${repository}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, color, description }),
      headers: { "content-type": "application/json" }
    })
  }
}

// The login GitHub gives comments written with the workflow's GITHUB_TOKEN.
export const BOT_LOGIN = "github-actions[bot]"

// Keeps model-written text from pinging people. GitHub resolves `@name` in the
// rendered text nodes whenever a non-word character (or nothing) precedes the
// `@`, after markdown and HTML entities are processed, so `.@a`, `_@a_`,
// `x*@a*` and `&#64;a` all ping. Decode every `@` entity, then put a
// zero-width space after each `@` not directly preceded by a letter or digit.
// A letter or digit cannot end a markdown construct, so it stays in the same
// text node and GitHub skips the `@` (an email address keeps its shape).
const AT_ENTITY = /&(?:#0*64;?|#x0*40;?|commat;)/gi
export const neutralizeMentions = (value) => value.replace(AT_ENTITY, "@").replace(/(?<![A-Za-z0-9])@/g, "@\u200b")

// The bot's own earlier triage comment, never one a user wrote with the marker.
export const findOwnComment = (comments, marker) =>
  comments.find((comment) => comment.user?.login === BOT_LOGIN && typeof comment.body === "string" && comment.body.includes(marker))

// `expectedNumber` is the issue or PR number the workflow bakes into the
// command line (`${{ github.event.issue.number }}`). The event file lives on
// the runner's disk, where the tests the flow runs could rewrite it, so apply
// refuses to write anywhere unless both agree.
export async function apply(kind, expectedNumber, eventPath = process.env.GITHUB_EVENT_PATH) {
  if (!Number.isSafeInteger(expectedNumber) || expectedNumber <= 0) throw new Error("apply needs the issue or PR number as an argument")
  const { repository, subject } = await readSubject(kind, eventPath)
  if (subject.number !== expectedNumber) throw new Error(`event names ${kind} ${subject.number}, not ${expectedNumber}`)
  const context = { repository, number: subject.number }
  let report
  try {
    const decoded = JSON.parse(await readFile(REPORT_PATH, "utf8"))
    report = validateReport(decoded, kind) ?? fallbackReport(kind, "the flow wrote a report that did not satisfy its contract")
  } catch (cause) {
    report = fallbackReport(kind, cause instanceof Error ? cause.message : String(cause))
  }
  for (const label of report.labels) await ensureLabel(context.repository, label)
  await api(`/repos/${context.repository}/issues/${context.number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: report.labels }),
    headers: { "content-type": "application/json" }
  })

  const marker = `<!-- smithers-${kind}-triage -->`
  const body = `${marker}\n## Smithers ${kind === "issue" ? "issue" : "PR"} triage\n\n${neutralizeMentions(report.comment)}\n\n<sub>${neutralizeMentions(report.summary)}</sub>`
  const comments = await api(`/repos/${context.repository}/issues/${context.number}/comments?per_page=100`)
  const existing = findOwnComment(comments, marker)
  await api(existing ? `/repos/${context.repository}/issues/comments/${existing.id}` : `/repos/${context.repository}/issues/${context.number}/comments`, {
    method: existing ? "PATCH" : "POST",
    body: JSON.stringify({ body }),
    headers: { "content-type": "application/json" }
  })
  return { ...report, number: context.number }
}

async function main() {
  const [command, kind, number] = process.argv.slice(2)
  const usage = "usage: github-triage.mjs prepare <issue|pr> | apply <issue|pr> <number>"
  if (!["prepare", "apply"].includes(command) || !["issue", "pr"].includes(kind)) throw new Error(usage)
  if (command === "apply" && !/^[1-9][0-9]*$/.test(number ?? "")) throw new Error(usage)
  const result = command === "prepare" ? await prepare(kind) : await apply(kind, Number(number))
  process.stdout.write(`${JSON.stringify({ ok: true, kind, number: result.number })}\n`)
}

if (isMain(import.meta)) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`)
    process.exitCode = 1
  })
}
