import assert from "node:assert/strict"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  evaluateExpression,
  interpolate,
  localEquivalents,
  parseWorkflow,
  rehearsalContexts
} from "./release-rehearsal.mjs"
import { repoRoot } from "./workspace-packages.mjs"

const release = parseWorkflow(
  readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8")
)

/**
 * Copies the driver into a fixture root so its steps run against that tree,
 * and links the repository's node_modules beside it so the copy still resolves
 * the pinned `yaml` parser.
 */
const installDriver = (root) => {
  mkdirSync(join(root, "scripts"))
  cpSync(join(repoRoot, "scripts/release-rehearsal.mjs"), join(root, "scripts/release-rehearsal.mjs"))
  cpSync(join(repoRoot, "scripts/workspace-packages.mjs"), join(root, "scripts/workspace-packages.mjs"))
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"))
}

/** The contexts the runner would build for a tag push. */
const pushContexts = (tag, runAttempt = "1") => ({
  github: { event_name: "push", ref_name: tag, run_attempt: runAttempt },
  inputs: {},
  runner: { temp: "/tmp/runner" },
  env: {}
})

/** The contexts the runner would build for a dispatched run. */
const dispatchContexts = (tag, dryRun, runAttempt = "1") => ({
  github: { event_name: "workflow_dispatch", ref_name: "main", run_attempt: runAttempt },
  inputs: { releaseTag: tag, dryRun },
  runner: { temp: "/tmp/runner" },
  env: {}
})

const jobEnv = (contexts) =>
  Object.fromEntries(
    Object.entries(release.jobs.publish.env).map(([key, value]) => [key, interpolate(value, contexts)])
  )

/** The condition every generated and mirrored gate step carries. */
const gateCondition = "${{ !cancelled() && steps.setup.conclusion == 'success' }}"

const step = (name) => release.jobs.publish.steps.find((candidate) => candidate.name === name)

const condition = (source, contexts) =>
  evaluateExpression(String(source).replaceAll(/\$\{\{|\}\}/g, ""), contexts)

test("parseWorkflow reads mappings, sequences, block scalars, and comments", () => {
  const parsed = parseWorkflow([
    "name: Example",
    "# a comment",
    "on:",
    "  push:",
    "    tags:",
    '      - "v*"',
    "jobs:",
    "  publish:",
    "    env:",
    "      TAG: ${{ github.ref_name }}",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: Two lines",
    "        if: env.DRY_RUN != 'true'",
    "        run: |",
    "          echo one  # not a yaml comment",
    "",
    "          echo two",
    ""
  ].join("\n"))

  assert.equal(parsed.name, "Example")
  assert.deepEqual(parsed.on.push.tags, ["v*"])
  assert.equal(parsed.jobs.publish.env.TAG, "${{ github.ref_name }}")
  assert.deepEqual(parsed.jobs.publish.steps[0], { uses: "actions/checkout@v4" })
  assert.equal(parsed.jobs.publish.steps[1].if, "env.DRY_RUN != 'true'")
  assert.equal(parsed.jobs.publish.steps[1].run, "echo one  # not a yaml comment\n\necho two\n")
})

test("parseWorkflow reads flow sequences and flow mappings the way the runner does", () => {
  const parsed = parseWorkflow("on:\n  push:\n    branches: [main, 'release/*']\n  workflow_dispatch: {}\n")
  assert.deepEqual(parsed.on.push.branches, ["main", "release/*"])
  assert.deepEqual(parsed.on.workflow_dispatch, {})
  assert.deepEqual(parseWorkflow("on:\n  push:\n    branches: [[main]]\n").on.push.branches, [["main"]])
})

test("parseWorkflow reads folded blocks, chomping indicators and double-quoted escapes by YAML 1.2 rules", () => {
  // root-infra/simplicity/1: the hand-written reader took `>` as a literal
  // block and left `\\n` in a double-quoted scalar undecoded, so the command
  // rehearsed differed from the command GitHub runs.
  const parsed = parseWorkflow([
    'name: "release\\nrehearsal"',
    "jobs:",
    "  publish:",
    "    steps:",
    "      - run: >",
    "          printf",
    "          hello",
    "      - run: |-",
    "          printf hello",
    "      - run: |",
    "          printf hello",
    ""
  ].join("\n"))
  assert.equal(parsed.name, "release\nrehearsal")
  assert.deepEqual(parsed.jobs.publish.steps.map((step) => step.run), ["printf hello\n", "printf hello", "printf hello\n"])
})

test("parseWorkflow fails closed on duplicate keys, malformed YAML and the wrong document shape", () => {
  assert.throws(() => parseWorkflow("name: one\nname: two\n"), /invalid workflow YAML: Map keys must be unique at line 2/)
  assert.throws(() => parseWorkflow("name: one\nunsupported syntax\njobs: {}\n"), /invalid workflow YAML: .* at line 2/)
  assert.throws(() => parseWorkflow("- a list\n"), /the document must be a mapping/)
  assert.throws(() => parseWorkflow("jobs:\n  publish:\n    steps: run\n"), /job publish steps must be a list of mappings/)
})

test("evaluateExpression implements the GitHub operator subset", () => {
  const contexts = { env: { DRY_RUN: "true" }, inputs: { dryRun: false, tag: "" } }
  assert.equal(evaluateExpression("env.DRY_RUN == 'true'", contexts), true)
  assert.equal(evaluateExpression("env.DRY_RUN != 'true'", contexts), false)
  assert.equal(evaluateExpression("!(env.DRY_RUN == 'true')", contexts), false)
  assert.equal(evaluateExpression("inputs.tag != '' && inputs.tag || 'fallback'", contexts), "fallback")
  assert.equal(evaluateExpression("inputs.missing", contexts), undefined)
  assert.equal(evaluateExpression("always()", contexts), true)
  assert.throws(() => evaluateExpression("always('argument')", contexts), /unsupported expression/)
  assert.throws(() => evaluateExpression("env.DRY_RUN =~ 'x'", contexts), /unsupported expression/)
})

test("a re-run attempt is refused before the first gate and only then", () => {
  // GitHub's "Re-run failed jobs" replays the whole job with no candidate
  // inputs: it rebuilds and repacks for an hour, then the archive step refuses
  // the second `release-candidate-<run-id>` upload. The guard is the first
  // step so that hour is never spent, and it fires on nothing else.
  const guard = step("Refuse a re-run attempt")
  assert.equal(release.jobs.publish.steps[0], guard)
  assert.match(guard.run, /candidateRunId=\$GITHUB_RUN_ID/)
  assert.match(guard.run, /release-resume\.md/)
  assert.match(guard.run, /exit 1/)
  assert.equal(condition(guard.if, pushContexts("v0.1.0", "1")), false)
  assert.equal(condition(guard.if, pushContexts("v0.1.0", "2")), true)
  assert.equal(condition(guard.if, dispatchContexts("v0.1.0", true, "1")), false)
  assert.equal(condition(guard.if, dispatchContexts("v0.1.0", true, "3")), true)
  // The rehearsal driver is always a first attempt.
  assert.equal(condition(guard.if, rehearsalContexts({ tag: "v0.1.0" })), false)
})

test("the publish receipt is archived after publication, even a partial one", () => {
  // publish-release.mjs rewrites publish-receipt.json after every package it
  // publishes, and the candidate archive is uploaded before publication, so
  // the receipt of a train that stopped halfway must be uploaded afterwards.
  const steps = release.jobs.publish.steps
  const upload = step("Upload the publish receipt")
  assert.ok(steps.indexOf(upload) > steps.indexOf(step("Publish packages in dependency order")))
  assert.ok(steps.indexOf(upload) > steps.indexOf(step("Archive tested release artifacts")))
  assert.equal(upload.if, "always()")
  assert.equal(upload.with.path, "${{ runner.temp }}/release-packs/publish-receipt.json")
  assert.equal(upload.with.name, "release-publish-receipt-${{ github.run_id }}")
  assert.equal(upload.with["if-no-files-found"], "ignore")
  assert.equal(upload.uses, step("Archive tested release artifacts").uses)
})

test("a tag push resolves the pushed tag and never enters the dry-run path", () => {
  const contexts = pushContexts("v0.1.0-next.0")
  const env = jobEnv(contexts)

  assert.equal(env.RELEASE_TAG, "v0.1.0-next.0")
  assert.equal(env.DRY_RUN, "false")
  contexts.env = env
  assert.equal(condition(step("Publish packages in dependency order").if, contexts), true)
  assert.equal(condition(step("Report the skipped publication").if, contexts), false)
})

test("a dispatched dry run validates the given tag and skips publication", () => {
  const contexts = dispatchContexts("v0.1.0-next.0-rc", true)
  const env = jobEnv(contexts)

  assert.equal(env.RELEASE_TAG, "v0.1.0-next.0-rc")
  assert.equal(env.DRY_RUN, "true")
  contexts.env = env
  assert.equal(condition(step("Publish packages in dependency order").if, contexts), false)
  assert.equal(condition(step("Report the skipped publication").if, contexts), true)
})

test("a dispatched run with dryRun off publishes, and an empty tag input falls back to the ref", () => {
  const contexts = dispatchContexts("", false)
  const env = jobEnv(contexts)

  assert.equal(env.RELEASE_TAG, "main")
  assert.equal(env.DRY_RUN, "false")
  contexts.env = env
  assert.equal(condition(step("Publish packages in dependency order").if, contexts), true)
})

test("runner temporary paths stay at step scope, where GitHub permits the runner context", () => {
  assert.equal(release.jobs.publish.env.PACK_DIR, undefined)
  assert.equal(release.jobs.publish.env.PUBLISH_ORDER, undefined)
  assert.equal(step("Pack and smoke-test release artifacts").env.PACK_DIR, "${{ runner.temp }}/release-packs")
  assert.equal(step("Compute the publish plan").env.PUBLISH_ORDER, "${{ runner.temp }}/publish-order.txt")
  assert.equal(step("Publish packages in dependency order").env.PACK_DIR, "${{ runner.temp }}/release-packs")
  assert.equal(step("Report the skipped publication").env.PUBLISH_ORDER, "${{ runner.temp }}/publish-order.txt")
})

test("publication keeps provenance and uses the repository token for first publications", () => {
  const publish = step("Publish packages in dependency order")

  assert.equal(publish.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}")
  assert.equal(publish.env.NPM_CONFIG_PROVENANCE, "true")
})

test("publication tolerates tag checkouts and bounded registry throttling", () => {
  const command = step("Publish packages in dependency order").run

  assert.match(command, /node scripts\/publish-release\.mjs/)
  const publisher = readFileSync(join(repoRoot, "scripts/publish-release.mjs"), "utf8")
  assert.match(publisher, /--no-git-checks/)
  assert.match(publisher, /retryDelays = \[10, 30, 60\]/)
  assert.match(publisher, /options\.pause\?\.\(2\)/)

})

test("only the re-run guard, candidate preparation and publication select a path; diagnostics survive failure", () => {
  // Every gate runs after an earlier red gate but never after failed setup,
  // exactly as the generated ci.yml renders it (#2071).
  const gates = release.jobs.publish.steps.filter((candidate) => /pnpm exec smthrs /.test(candidate.run ?? ""))
  assert.ok(gates.length > 30)
  assert.deepEqual(gates.filter((candidate) => candidate.if !== gateCondition).map((candidate) => candidate.name), [])
  assert.deepEqual(release.jobs.publish.steps.filter((candidate) => candidate.id === "setup").map((candidate) => candidate.if), [undefined])
  const conditional = release.jobs.publish.steps
    .filter((candidate) => candidate.if !== undefined && !gates.includes(candidate))
    .map((candidate) => candidate.name)

  assert.deepEqual(conditional, [
    "Refuse a re-run attempt",
    "Upload product deployment mode matrix receipt",
    "Build all workspaces from clean artifacts",
    "Review declaration API drift",
    "Retrieve native helpers for npm",
    "Install the supported Node floor",
    "Install certified npm for the Node floor",
    "Pack and smoke-test release artifacts",
    "Restore and verify archived release candidate",
    "Collect ci-test-tier-evidence",
    "Upload ci-test-tier-evidence",
    "Upload release runtime smoke evidence",
    "Publish packages in dependency order",
    "Upload the publish receipt",
    "Report the skipped publication"
  ])
  assert.equal(step("Collect ci-test-tier-evidence").if, "always()")
  assert.equal(step("Upload product deployment mode matrix receipt").if, "always()")
  assert.equal(step("Upload the publish receipt").if, "always()")
  assert.equal(step("Upload ci-test-tier-evidence").if, "always()")
  assert.equal(step("Upload release runtime smoke evidence").if, "always()")
  assert.equal(step("Archive tested release artifacts").if, undefined)
})

test("release builds the checked public graph and pins npm before smoke", () => {
  assert.equal(step("Build all workspaces from clean artifacts").run, "node scripts/build-release.mjs")
  const install = step("Install certified npm")
  assert.match(install.run, /npm install --global 'npm@11\.16\.0' /)
  assert.match(install.run, /npm --version/)
  assert.equal(install.if, undefined)
  assert.ok(release.jobs.publish.steps.indexOf(install) < release.jobs.publish.steps.indexOf(step("Workspace targets")))
})

test("the supported Node floor packs and smokes the tarballs and retains its receipt", () => {
  const smoke = step("Pack and smoke-test release artifacts")
  assert.equal(step("Install the supported Node floor").with["node-version"], "26.4.0")
  assert.match(step("Install certified npm for the Node floor").run, /npm install --global 'npm@11\.16\.0'/)
  const names = release.jobs.publish.steps.map((candidate) => candidate.name)
  assert.ok(names.indexOf("Install the supported Node floor") < names.indexOf("Install certified npm for the Node floor"))
  assert.ok(names.indexOf("Install certified npm for the Node floor") < names.indexOf(smoke.name))
  assert.ok(names.indexOf(smoke.name) < names.indexOf("Archive tested release artifacts"))
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-runtime-smoke-workflow-")))
  try {
    const bin = join(root, "bin")
    mkdirSync(bin)
    const driver = join(root, "node.cjs")
    writeFileSync(driver, [
      'const fs = require("node:fs"), path = require("node:path")',
      'const [command, directory] = process.argv.slice(2)',
      'if (command === "--version") { console.log(process.env.MOCK_NODE_VERSION); process.exit(0) }',
      'fs.appendFileSync(process.env.TRACE, JSON.stringify([command, directory, process.env.MOCK_NODE_VERSION]) + "\\n")',
      'if (command === "scripts/pack-release.mjs") { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "package.tgz"), "fixed candidate bytes") }',
      'else if (command === "scripts/smoke-release.mjs") {',
      '  const bytes = fs.readFileSync(path.join(directory, "package.tgz"), "utf8")',
      '  fs.writeFileSync(path.join(directory, "smoke-evidence.json"), JSON.stringify({ bytes, node: process.env.MOCK_NODE_VERSION }))',
      '} else throw new Error("unexpected release command")'
    ].join("\n"))
    writeFileSync(join(bin, "node"), '#!/bin/sh\nexec "$ACTUAL_NODE" "$MOCK_NODE_DRIVER" "$@"\n')
    writeFileSync(join(bin, "npm"), '#!/bin/sh\n[ "$1" = --version ] || exit 90\nprintf "11.16.0\\n"\n')
    chmodSync(join(bin, "node"), 0o755)
    chmodSync(join(bin, "npm"), 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ACTUAL_NODE: process.execPath,
      MOCK_NODE_DRIVER: driver, PACK_DIR: join(root, "packs"), SMOKE_EVIDENCE_DIR: join(root, "receipts"), TRACE: join(root, "trace.jsonl") }
    const run = (body, version) => spawnSync("bash", ["-e", "-c", body], { cwd: root,
      env: { ...env, MOCK_NODE_VERSION: version }, encoding: "utf8" })
    assert.notEqual(run(smoke.run, "v26.5.0").status, 0, "a skipped setup action cannot mislabel another Node as the floor")
    assert.equal(existsSync(join(env.SMOKE_EVIDENCE_DIR, "node26.json")), false)
    const floor = run(smoke.run, "v26.4.0")
    assert.equal(floor.status, 0, floor.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(env.SMOKE_EVIDENCE_DIR, "node26.json"), "utf8")), { bytes: "fixed candidate bytes", node: "v26.4.0" })
    const calls = readFileSync(env.TRACE, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(calls, [["scripts/pack-release.mjs", env.PACK_DIR, "v26.4.0"], ["scripts/smoke-release.mjs", env.PACK_DIR, "v26.4.0"]])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("archived retries restore an explicit immutable artifact without rebuilding or replacing smoke evidence", () => {
  for (const restore of [false, true]) {
    for (const dryRun of [false, true]) {
      const contexts = dispatchContexts("v1.0.0-rc.0", dryRun)
      contexts.inputs.candidateRunId = restore ? "10" : ""
      contexts.inputs.candidateArtifactId = restore ? "20" : ""
      contexts.env = jobEnv(contexts)
      assert.equal(condition(step("Build all workspaces from clean artifacts").if, contexts), !restore)
      assert.equal(condition(step("Pack and smoke-test release artifacts").if, contexts), !restore)
      for (const name of ["Install the supported Node floor", "Install certified npm for the Node floor"]) {
        assert.equal(condition(step(name).if, contexts), !restore)
      }
      assert.equal(condition(step("Restore and verify archived release candidate").if, contexts), restore)
      assert.equal(condition(step("Publish packages in dependency order").if, contexts), !dryRun)
    }
  }
  assert.equal(release.on.workflow_dispatch.inputs.candidateRunId.default, "")
  assert.equal(release.on.workflow_dispatch.inputs.candidateArtifactId.default, "")
  assert.equal(release.jobs.publish.permissions.actions, "read")
  const restore = step("Restore and verify archived release candidate")
  assert.equal(restore.run, 'node scripts/restore-release.mjs "$PACK_DIR"')
  assert.equal(restore.env.GH_TOKEN, "${{ github.token }}")
  const names = release.jobs.publish.steps.map((candidate) => candidate.name)
  assert.ok(names.indexOf("Validate archived candidate selection") < names.indexOf("Workspace targets"))
  assert.ok(names.indexOf("Restore and verify archived release candidate") < names.indexOf("Archive tested release artifacts"))
  assert.ok(names.indexOf("Archive tested release artifacts") < names.indexOf("Publish packages in dependency order"))
})

test("the driver reads the toolchain steps copied out of ci.yml", () => {
  // The copied blocks are the first shapes in this file that pair a `|` block
  // scalar with a later `shell:` key, and the first `with:` maps the driver
  // has to read on a step it does not execute. A reader that mis-parsed one
  // would report the release as green while skipping a step.
  const containerd = step("Enable the containerd image store")
  assert.equal(containerd.shell, "bash")
  assert.match(containerd.run, /^if command -v docker /)
  const systemPackages = step("Install system packages")
  assert.equal(systemPackages.shell, "bash")
  assert.match(systemPackages.run, /--no-install-recommends 'bubblewrap'/)
  assert.equal(step("Install ripgrep").with.tool, "ripgrep@14.1.1")
  assert.equal(step("Install Go").with["go-version"], "1.26.8")
  assert.equal(step("Install Foundry").with.version, "v1.8.1")
  const postgres = step("Install PostgreSQL")
  assert.equal(postgres.shell, "bash")
  assert.match(postgres.run, /--no-install-recommends 'postgresql-18'/)
  assert.match(postgres.run, />> "\$GITHUB_PATH"$/m)
})

test("the toolchain the gates need is installed before the first gate", () => {
  const names = release.jobs.publish.steps.map((candidate) => candidate.name ?? candidate.uses)
  const firstGate = names.indexOf("Workspace targets")
  assert.notEqual(firstGate, -1, "release.yml no longer runs the workspace target graph")
  for (const name of ["Install Go", "Install Foundry", "Install ripgrep", "Install system packages", "Install PostgreSQL"]) {
    const index = names.indexOf(name)
    assert.notEqual(index, -1, `release.yml does not install ${name.replace("Install ", "")}`)
    assert.ok(index < firstGate, `${name} must run before the first gate`)
  }
  // actions/setup-go prepends its own bin directories to PATH and displaces
  // the shim corepack put there, which killed every nested `pnpm` the build
  // tool spawned. The package manager's setup therefore has to come after it,
  // which is the order GithubCiGen renders and this file copies.
  const packageManager = names.findIndex(
    (name) => typeof name === "string" && name.startsWith("pnpm/action-setup@")
  )
  assert.notEqual(packageManager, -1, "release.yml does not install pnpm")
  assert.ok(names.indexOf("Install Go") < packageManager)
})

test("the rehearsal driver documents a local equivalent for every action the release uses", () => {
  const undocumented = release.jobs.publish.steps
    .filter((candidate) => candidate.uses !== undefined)
    .map((candidate) => candidate.uses.split("@")[0])
    .filter((action) => !(action in localEquivalents))

  assert.deepEqual(undocumented, [])
})

test("the dispatch inputs keep the rehearsal safe by default", () => {
  const inputs = release.on.workflow_dispatch.inputs
  assert.equal(inputs.dryRun.type, "boolean")
  assert.equal(inputs.dryRun.default, true)
  assert.equal(inputs.releaseTag.default, "")
  assert.equal(inputs.sourceRef.type, "string")
  assert.equal(inputs.sourceRef.default, "")
})

test("CI gates the server's checks and tests in the required test job", () => {
  const ci = parseWorkflow(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"))
  const server = ci.jobs.test.steps.find((entry) => entry.name === "Server typecheck and tests")
  assert.equal(server?.run, "pnpm exec smthrs ci '//apps/server/...' --known-red '.github/ci-known-red.json' --verbose")
  assert.equal(server?.if, gateCondition)
})

test("ordinary PR CI gates executable examples before workspace checks", () => {
  const ci = parseWorkflow(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"))
  const steps = ci.jobs.test.steps
  const examples = steps.find((entry) => entry.name === "Examples")
  assert.equal(Object.hasOwn(ci.on, "pull_request"), true)
  assert.equal(ci.jobs.test["continue-on-error"], undefined)
  assert.equal(examples?.run, "pnpm exec smthrs ci '//examples/...' --known-red '.github/ci-known-red.json' --verbose")
  assert.equal(examples?.if, gateCondition)
  assert.ok(steps.indexOf(examples) < steps.indexOf(steps.find((entry) => entry.name === "Workspace targets")))
})

test("a failed gate retains diagnostic files and failure status while skipping later gates", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-failure-artifacts-")))
  try {
    installDriver(root)
    writeFileSync(join(root, "workflow.yml"), [
      "name: Fixture", "jobs:", "  publish:", "    steps:",
      "      - name: Failing gate",
      "        run: echo failure evidence > failed.log; exit 23",
      "      - name: Later required gate",
      "        run: exit 24",
      "      - name: Collect diagnostics",
      "        if: always()",
      '        run: cp failed.log "$RUNNER_TEMP/evidence.log"'
    ].join("\n"))
    const result = spawnSync(process.execPath, [
      join(root, "scripts/release-rehearsal.mjs"), "--workflow", "workflow.yml",
      "--runner-temp", join(root, "runner"), "--transcript", join(root, "transcript.json")
    ], { encoding: "utf8", timeout: 30_000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const transcript = JSON.parse(readFileSync(join(root, "transcript.json"), "utf8"))
    assert.deepEqual(transcript.steps.map((entry) => [entry.status, entry.exitCode]), [
      ["failed", 23], ["skipped", 0], ["passed", 0]
    ])
    assert.equal(readFileSync(join(root, "runner/evidence.log"), "utf8"), "failure evidence\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a red gate does not skip a later setup-gated gate, and failed setup skips them all", () => {
  const rehearse = (setupExit) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "release-independent-gates-")))
    try {
      installDriver(root)
      writeFileSync(join(root, "workflow.yml"), [
        "name: Fixture", "jobs:", "  publish:", "    steps:",
        "      - name: Setup",
        "        id: setup",
        `        run: exit ${setupExit}`,
        "      - name: Failing gate",
        `        if: ${gateCondition}`,
        "        run: exit 23",
        "      - name: Later gate",
        `        if: ${gateCondition}`,
        "        run: exit 0",
        "      - name: Publish",
        "        run: exit 0"
      ].join("\n"))
      const result = spawnSync(process.execPath, [
        join(root, "scripts/release-rehearsal.mjs"), "--workflow", "workflow.yml",
        "--runner-temp", join(root, "runner"), "--transcript", join(root, "transcript.json")
      ], { encoding: "utf8", timeout: 30_000 })
      assert.equal(result.status, 1, result.stdout + result.stderr)
      return JSON.parse(readFileSync(join(root, "transcript.json"), "utf8")).steps.map((entry) => entry.status)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(rehearse(0), ["passed", "failed", "passed", "skipped"])
  assert.deepEqual(rehearse(9), ["failed", "skipped", "skipped", "skipped"])
})

test("release rebuilds and byte-compares the committed wasm before packing", () => {
  const ci = parseWorkflow(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"))
  const steps = release.jobs.publish.steps
  const pack = steps.indexOf(step("Pack and smoke-test release artifacts"))
  const install = step("Install pinned Rust toolchain")
  assert.ok(install, "release must install the pinned Rust toolchain")
  // `id: setup` marks the last setup step of each ci.yml job; the release marks its own.
  const { id: _, ...ciInstall } = ci.jobs["wasm-repro"].steps.find((entry) => entry.name === install.name)
  assert.deepEqual(install, ciInstall)
  const mirrored = ci.jobs["wasm-repro"].steps.filter((entry) => /pnpm exec (?:smithers-build|smthrs) /.test(entry.run ?? ""))
  assert.equal(mirrored.length, 2, "the wasm mirror must cover both smthrs steps; an executable rename must not empty it")
  for (const ciStep of mirrored) {
    // The release runs without ci.yml's known-red list: every target it
    // mirrors must be green there.
    const expected = { ...ciStep, run: ciStep.run.replace(/ --known-red '[^']+'/, "") }
    const actual = step(expected.name)
    assert.deepEqual(actual, expected)
    assert.ok(steps.indexOf(install) < steps.indexOf(actual))
    assert.ok(steps.indexOf(actual) < pack)
    assert.equal(actual.if, gateCondition)
  }
})

test("a directory a step appends to $GITHUB_PATH leads PATH for later steps", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-github-path-")))
  try {
    installDriver(root)
    writeFileSync(join(root, "workflow.yml"), [
      "name: Fixture", "jobs:", "  publish:", "    steps:",
      "      - name: Add tool directory",
      "        run: echo /opt/fixture-tool/bin >> \"$GITHUB_PATH\"",
      "      - name: Read PATH",
      "        run: case \"$PATH\" in /opt/fixture-tool/bin:*) exit 0 ;; *) exit 23 ;; esac"
    ].join("\n"))
    const result = spawnSync(process.execPath, [
      join(root, "scripts/release-rehearsal.mjs"), "--workflow", "workflow.yml",
      "--runner-temp", join(root, "runner"), "--transcript", join(root, "transcript.json")
    ], { encoding: "utf8", timeout: 30_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const transcript = JSON.parse(readFileSync(join(root, "transcript.json"), "utf8"))
    assert.deepEqual(transcript.steps.map((entry) => entry.status), ["passed", "passed"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a colocated rehearsal skips initialization and continues to the next gate", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-colocated-")))
  try {
    installDriver(root)
    mkdirSync(join(root, ".jj"))
    writeFileSync(join(root, "workflow.yml"), [
      "name: Fixture", "jobs:", "  publish:", "    steps:",
      "      - name: Initialize colocated jj repository",
      "        run: exit 23",
      "      - name: Following gate",
      "        run: echo gate passed"
    ].join("\n"))
    const run = () => spawnSync(process.execPath, [
      join(root, "scripts/release-rehearsal.mjs"), "--workflow", "workflow.yml",
      "--transcript", join(root, "transcript.json")
    ], { encoding: "utf8", timeout: 30_000 })
    const colocated = run()
    assert.equal(colocated.status, 0, colocated.stdout + colocated.stderr)
    const transcript = JSON.parse(readFileSync(join(root, "transcript.json"), "utf8"))
    assert.deepEqual(transcript.steps.map((entry) => entry.status), ["skipped", "passed"])
    assert.match(colocated.stdout, /already colocated/)
    rmSync(join(root, ".jj"), { recursive: true })
    assert.equal(run().status, 1, "a fresh checkout must still attempt initialization")
    assert.equal(JSON.parse(readFileSync(join(root, "transcript.json"), "utf8")).steps[0].exitCode, 23)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("the driver switches PATH to the toolchain each setup-node step pins", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-toolchain-switch-")))
  try {
    installDriver(root)
    const toolchain = (version) => {
      const bin = join(root, `node-${version}`, "bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "node"), `#!/bin/sh\n[ "$1" = --version ] || exit 90\nprintf 'v${version}\\n'\n`)
      chmodSync(join(bin, "node"), 0o755)
      return bin
    }
    writeFileSync(join(root, "workflow.yml"), [
      "name: Fixture", "jobs:", "  publish:", "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 26.5.0",
      "      - name: Gate on the default line",
      "        run: test \"$(node --version)\" = 'v26.5.0'",
      "      - name: Install the supported Node floor",
      "        uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 26.4.0",
      "      - name: Gate on the floor line",
      "        run: test \"$(node --version)\" = 'v26.4.0'"
    ].join("\n"))
    const result = spawnSync(process.execPath, [
      join(root, "scripts/release-rehearsal.mjs"), "--workflow", "workflow.yml",
      "--transcript", join(root, "transcript.json"),
      "--node", `26.5.0=${toolchain("26.5.0")}`, "--node", `26.4.0=${toolchain("26.4.0")}`
    ], { encoding: "utf8", timeout: 30_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const transcript = JSON.parse(readFileSync(join(root, "transcript.json"), "utf8"))
    assert.deepEqual(transcript.steps.map((entry) => entry.status), ["skipped", "passed", "skipped", "passed"])
    assert.match(result.stdout, /PATH now resolves Node 26\.4\.0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("release checks out the requested candidate, serializes its tag, and archives before publication", () => {
  const contexts = { github: { ref: "refs/heads/main", ref_name: "main" }, inputs: { releaseTag: "v1.0.0-rc.0" } }
  const steps = release.jobs.publish.steps
  const checkout = steps.find((item) => item.uses?.startsWith("actions/checkout@"))
  assert.equal(interpolate(checkout.with.ref, contexts), "v1.0.0-rc.0")
  assert.equal(interpolate(release.concurrency.group, contexts), "release-v1.0.0-rc.0")
  const pushed = { github: { ref: "refs/tags/v1.0.0-rc.0", ref_name: "v1.0.0-rc.0" }, inputs: {} }
  assert.equal(interpolate(release.concurrency.group, pushed), "release-v1.0.0-rc.0")
  assert.equal(release.concurrency["cancel-in-progress"], false)
  const archive = steps.findIndex((item) => item.uses?.startsWith("actions/upload-artifact@"))
  const publish = steps.findIndex((item) => item.run?.includes("node scripts/publish-release.mjs"))
  assert.ok(archive >= 0 && publish > archive)
  assert.equal(steps[archive].with["if-no-files-found"], "error")
})

/** Run the workflow's own guards against real, isolated Git histories. */
const withSourceRepository = (format, check) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-source-ref-")))
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1"
  }
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 10_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  const run = (name, contexts) => spawnSync("bash", [
    "--noprofile", "--norc", "-eo", "pipefail", "-c", interpolate(step(name).run, contexts)
  ], {
    cwd: root,
    env: { ...env, ...jobEnv(contexts), GITHUB_EVENT_NAME: contexts.github.event_name },
    encoding: "utf8",
    timeout: 10_000
  })
  try {
    git("init", `--object-format=${format}`, "-b", "main")
    git("config", "user.name", "Release source fixture")
    git("config", "user.email", "release-source@example.invalid")
    git("commit", "--allow-empty", "-m", "Initial candidate")
    const candidate = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-m", "Later main commit")
    const tip = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", tip)
    git("checkout", "--detach", candidate)
    check({ root, git, run, candidate, tip })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const sourceContexts = (sourceRef) => {
  const contexts = dispatchContexts("v1.0.0-rc.0", true)
  contexts.github.ref = "refs/heads/main"
  contexts.inputs.sourceRef = sourceRef
  contexts.env = jobEnv(contexts)
  return contexts
}

for (const format of ["sha1", "sha256"]) {
  test(`an untagged ${format} candidate is pinned independently of its intended release version`, () =>
    withSourceRepository(format, ({ git, run, candidate, tip }) => {
      assert.notEqual(candidate, tip, "the selected source may be an older main commit")
      assert.equal(git("tag", "--list"), "")
      const contexts = sourceContexts(candidate)
      const steps = release.jobs.publish.steps
      const checkout = steps.find((entry) => entry.uses?.startsWith("actions/checkout@"))
      assert.equal(interpolate(checkout.with.ref, contexts), candidate)
      assert.equal(contexts.env.RELEASE_TAG, "v1.0.0-rc.0")
      assert.equal(run("Validate explicit dry-run source", contexts).status, 0)
      assert.equal(run("Verify explicit dry-run source", contexts).status, 0)
      const uppercase = sourceContexts(candidate.toUpperCase())
      assert.equal(run("Validate explicit dry-run source", uppercase).status, 0)
      assert.equal(run("Verify explicit dry-run source", uppercase).status, 0)
      assert.equal(git("rev-parse", "HEAD"), candidate)
      assert.equal(git("status", "--porcelain"), "")
      assert.equal(condition(step("Publish packages in dependency order").if, contexts), false)
      contexts.env.DRY_RUN = "false"
      assert.equal(condition(step("Publish packages in dependency order").if, contexts), false,
        "the explicit source input independently forbids publication")
      assert.ok(steps.indexOf(step("Validate explicit dry-run source")) < steps.indexOf(checkout))
      assert.ok(steps.indexOf(checkout) < steps.indexOf(step("Verify explicit dry-run source")))
      assert.ok(steps.indexOf(step("Verify explicit dry-run source")) < steps.indexOf(step("Install pinned Rust toolchain")))
    }))
}

test("the actual source guard refuses publication, non-dispatch events, and any archived selection", () =>
  withSourceRepository("sha1", ({ run, candidate }) => {
    const forbidden = [
      { inputs: { dryRun: false } },
      { event: "push" },
      { event: "schedule" },
      { inputs: { candidateRunId: "10" } },
      { inputs: { candidateArtifactId: "20" } },
      { inputs: { candidateRunId: "10", candidateArtifactId: "20" } }
    ]
    for (const variant of forbidden) {
      const contexts = sourceContexts(candidate)
      Object.assign(contexts.inputs, variant.inputs)
      if (variant.event !== undefined) contexts.github.event_name = variant.event
      const result = run("Validate explicit dry-run source", contexts)
      assert.notEqual(result.status, 0, JSON.stringify(variant))
      assert.match(result.stderr, /only for a fresh workflow_dispatch dry run/)
    }
    for (const contexts of [pushContexts("v1.0.0-rc.0"), dispatchContexts("v1.0.0-rc.0", false)]) {
      assert.equal(run("Validate explicit dry-run source", contexts).status, 0)
      assert.equal(run("Verify explicit dry-run source", contexts).status, 0)
    }
  }))

test("the actual source guard requires a full hexadecimal SHA and a release version label", () =>
  withSourceRepository("sha1", ({ run, candidate }) => {
    for (const value of ["main", "refs/heads/main", candidate.slice(0, 12), `${candidate}0`, "g".repeat(40), `${candidate}\n`, `${candidate}; true`]) {
      const result = run("Validate explicit dry-run source", sourceContexts(value))
      assert.notEqual(result.status, 0, JSON.stringify(value))
      assert.match(result.stderr, /full 40- or 64-character hexadecimal commit SHA/)
    }
    const contexts = sourceContexts(candidate)
    contexts.inputs.releaseTag = ""
    const result = run("Validate explicit dry-run source", contexts)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /requires releaseTag in v<version> format/)
  }))

test("the actual source verifier refuses a different checkout, unrelated history, and missing main", () =>
  withSourceRepository("sha1", ({ git, run, candidate, tip }) => {
    const mismatch = run("Verify explicit dry-run source", sourceContexts(tip))
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /checked-out source does not match sourceRef/)

    const unrelated = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-m", "Unrelated candidate")
    git("checkout", "--detach", unrelated)
    const outside = run("Verify explicit dry-run source", sourceContexts(unrelated))
    assert.notEqual(outside.status, 0)
    assert.match(outside.stderr, /must be reachable from origin\/main/)

    git("checkout", "--detach", candidate)
    git("update-ref", "-d", "refs/remotes/origin/main")
    const missing = run("Verify explicit dry-run source", sourceContexts(candidate))
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /must be reachable from origin\/main/)
  }))
