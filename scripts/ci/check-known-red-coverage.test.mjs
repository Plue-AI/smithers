import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { describe, fingerprint } from "../../packages/smithers/build/build-cli/src/KnownRed.ts"
import { failedTargets, uncovered } from "./check-known-red-coverage.mjs"

const script = resolve(import.meta.dirname, "check-known-red-coverage.mjs")
const today = "2026-09-28"
const entry = (label, fields = {}) => ({
  label,
  owner: "will",
  reason: "fixture",
  issue: "https://github.com/smithersai/smithers/issues/1",
  expires: "2026-10-24",
  failureDigest: fingerprint("reviewed failure"),
  ...fields
})
const judge = (labels, { platform = "linux", ...fields } = {}) =>
  uncovered({ failed: labels.map((label) => ({ label, platform })), entries: [], issues: [], today, ...fields })
    .map((red) => red.label)

test("reads every failed target the known-red verdict printed, once each", () => {
  const log = [
    "2026-09-28T04:06:04.0933674Z newly red, no matching failure in .github/ci-known-red.json: //packages/smithers/build:fmt",
    "2026-09-28T04:06:04.0937106Z known red (.github/ci-known-red.json): //packages/smithers:test",
    "//packages/smithers/agent/integrations:test: WARN Telegram poll failed; retrying",
    "not run, a dependency is red: //scripts:consumer",
    "green again, remove from .github/ci-known-red.json: //scripts:ok",
    "newly red, no matching failure in .github/ci-known-red.json: //packages/smithers/build:fmt"
  ].join("\n")
  assert.deepEqual(failedTargets(log), [
    { label: "//packages/smithers/build:fmt", platform: "linux" },
    { label: "//packages/smithers:test", platform: "linux" }
  ])
})

test("judges each red on the platform of the job that printed it", () => {
  const label = "//packages/smithers/build/build-cli:test"
  const line = (job) => `${job}\tWorkspace targets\t2026-09-28T04:00:00Z known red (.github/ci-known-red.json): ${label}`
  const windows = line("package suites (windows-latest)")
  const linux = line("workspace graph (coverage gates enforced)")
  assert.deepEqual(failedTargets([windows, line("package suites (macos-latest)"), linux, windows].join("\n")), [
    { label, platform: "win32" },
    { label, platform: "darwin" },
    { label, platform: "linux" }
  ])
  const entries = [entry(label, { platforms: ["win32"] })]
  const judged = (log) => uncovered({ failed: failedTargets(log), entries, issues: [], today })
  assert.deepEqual(judged(windows), [])
  assert.deepEqual(judged([windows, linux].join("\n")), [{ label, platform: "linux" }])
})

test("reports an uncovered failed target", () => {
  assert.deepEqual(judge(["//scripts:releaseSmoke"]), ["//scripts:releaseSmoke"])
  assert.deepEqual(judge([]), [])
})

test("reports a Linux failure despite a Windows-only exemption", () => {
  const label = "//packages/smithers/build/build-cli:test"
  assert.deepEqual(judge([label], { entries: [entry(label, { platforms: ["win32"] })] }), [label])
  assert.deepEqual(judge([label], { entries: [entry(label, { platforms: ["win32"] })], platform: "win32" }), [])
})

test("refuses an expired exemption, and holds one through its last day", () => {
  const label = "//scripts:apiBaseline"
  assert.deepEqual(judge([label], { entries: [entry(label, { expires: "2026-09-27" })] }), [label])
  assert.deepEqual(judge([label], { entries: [entry(label, { expires: today })] }), [])
})

test("accepts an open exact-target owner and rejects a closed or partial-title match", () => {
  const label = "//scripts:test"
  const owned = (issues) => judge([label], { issues })
  assert.deepEqual(owned([{ title: "CI: //scripts:test fails on Linux", state: "OPEN" }]), [])
  assert.deepEqual(owned([{ title: "CI: `//scripts:test` fails", state: "OPEN" }]), [])
  assert.deepEqual(owned([{ title: "CI: //scripts:test fails on Linux", state: "CLOSED" }]), [label])
  assert.deepEqual(owned([{ title: "CI: //scripts:testPinRegister is red", state: "OPEN" }]), [label])
  assert.deepEqual(owned([{ title: "CI: //other//scripts:test is red", state: "OPEN" }]), [label])
})

test("refuses unavailable owner data rather than reading it as no owners", () => {
  assert.throws(() => judge(["//scripts:test"], { issues: undefined }), /issue list/)
  assert.throws(() => judge(["//scripts:test"], { issues: [{ state: "OPEN" }] }), /issue list/)
})

const cli = (log, issues, args = []) => {
  const root = mkdtempSync(join(tmpdir(), "known-red-coverage-"))
  try {
    const knownRed = join(root, "known-red.json")
    writeFileSync(knownRed, JSON.stringify({ entries: [entry("//a:test")] }))
    const issuesFile = join(root, "issues.json")
    writeFileSync(issuesFile, issues)
    return spawnSync(
      process.execPath,
      [script, "--known-red", knownRed, "--issues", issuesFile, "--platform", "linux", "--today", today, ...args],
      { input: log, encoding: "utf8" }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("the command fails on an unowned red and passes when every red has an owner", () => {
  const log = "known red (x): //a:test\nnewly red, no matching failure in x: //b:test\n"
  const red = cli(log, "[]")
  assert.equal(red.status, 1, red.stderr)
  assert.match(red.stderr, /no owner: \/\/b:test \(linux\)/)
  assert.doesNotMatch(red.stderr, /\/\/a:test/)
  const green = cli(log, JSON.stringify([{ title: "//b:test is red", state: "OPEN" }]))
  assert.equal(green.status, 0, green.stderr)
})

test("the command rejects an unowned red from KnownRed.describe output", () => {
  const label = "//b:test"
  const log = `${describe({
    source: "x",
    known: [],
    newlyRed: [label],
    observed: [{ label, failureDigest: fingerprint("different failure") }],
    unrun: [],
    expired: [],
    recovered: []
  }).join("\n")}\n`
  const result = cli(log, "[]")
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /no owner: \/\/b:test/)
})

test("the command exits 2 when the issue list cannot be read", () => {
  const result = cli("newly red, no matching failure in x: //b:test\n", "{not json")
  assert.equal(result.status, 2, result.stderr)
})
