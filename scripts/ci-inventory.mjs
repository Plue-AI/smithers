/** Resolve CI commands through the working-tree planner, retaining the actual runner and inputs. */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { createPlanner } from "./ci-planner.mjs"
import { parseWorkflow } from "./release-rehearsal.mjs"
import { openPackageIndex } from "@smthrs/build-cli/Cli"
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"
import * as Cargo from "@smthrs/targets/Cargo"
import * as NodeBinary from "@smthrs/targets/NodeBinary"
import * as NodeTest from "@smthrs/targets/NodeTest"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as PackageExec from "@smthrs/build-cli/PackageExec"
import { isMain, repoRoot } from "./workspace-packages.mjs"

export const root = repoRoot
export const cli = resolve(root, "packages/smithers/src/bin.ts")

/** Recognize target invocations without silently dropping a newly added option. */
export function targetInvocation(run) {
  if (typeof run !== "string" || !/^pnpm exec smthrs (?:ci|test|build|lint|docs)\b/.test(run)) return undefined
  const match = run.match(/^pnpm exec smthrs (ci|test|build|lint|docs) '(\/\/[^']+)'(.*)$/)
  if (!match) throw new Error(`Unrecognized CI target invocation: ${run}`)
  const [, verb, pattern, tail] = match
  const options = tail.trim() === "" ? [] : tail.trim().split(/\s+/)
  let jobs
  let knownRed
  let verbose = false
  for (let index = 0; index < options.length; index++) {
    const option = options[index]
    if (option === "--verbose" && !verbose) verbose = true
    else if (option === "--jobs" && jobs === undefined && /^[1-9]\d*$/.test(options[index + 1] ?? "")) {
      jobs = Number(options[++index])
    } else if (option === "--known-red" && knownRed === undefined && /^'[^']+'$/.test(options[index + 1] ?? "")) {
      knownRed = options[++index].slice(1, -1)
    } else throw new Error(`Unrecognized CI target option in: ${run}`)
  }
  return knownRed === undefined ? { verb, pattern, jobs, verbose } : { verb, pattern, jobs, knownRed, verbose }
}

export function planned(verb, pattern, workspace = root) {
  const result = spawnSync(process.execPath, [cli, verb, pattern, "--plan", "--json", "--workspace", workspace], {
    cwd: workspace, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" }
  })
  if (result.error || result.status !== 0) throw new Error(`Planning ${verb} ${pattern} failed: ${result.error ?? result.stdout + result.stderr}`)
  return JSON.parse(result.stdout)
}

/**
 * Run serial inventory selections through the public CLI's real process host.
 * Each invocation still parses argv, discovers declarations and plans afresh.
 * Sharing loaded modules in the persistent child avoids CLI startup per row.
 * Its parent enforces the deadline, independent of this host's event loop.
 * The repo-contract test also compares its full output with the executable.
 */
export async function plannedInProcess(verb, pattern, workspace = root) {
  installEffectResolution()
  const { main } = await import("@smthrs/cli/cli/Entry")
  let stdout = ""
  let stderr = ""
  let status = 0
  await main({
    argv: [verb, pattern, "--plan", "--json", "--workspace", workspace],
    env: { ...process.env, SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" },
    stdout: { write: (text) => { stdout += text } },
    stderr: { write: (text) => { stderr += text } },
    on: (signal, listener) => { process.on(signal, listener) },
    removeListener: (signal, listener) => { process.removeListener(signal, listener) },
    setExitCode: (code) => { status = code }
  })
  if (status !== 0) throw new Error(`Planning ${verb} ${pattern} failed: ${stdout + stderr}`)
  return JSON.parse(stdout)
}

export function runnerFor(metadata, workspace, verb) {
  const attrs = metadata.attrs
  if (metadata.target === "NodeTest") return NodeTest.runArgv({ ...attrs, runtime: attrs.runtime ?? workspace.runtime })
  if (metadata.target === "NodeBinary") return NodeBinary.runArgv({ ...attrs, runtime: attrs.runtime ?? workspace.runtime })
  if (Cargo.packageRules.includes(metadata.target)) {
    const selection = Cargo.selectionOf(attrs)
    if (!selection) throw new Error(`Expand the resolved crate-set runner for ${metadata.target}`)
    return ["cargo", ...Cargo.packageArgs(metadata.target, attrs, selection, verb === "lint" ? "check" : "execute")]
  }
  if (metadata.target === "Vitest") return PackageManager.exec(
    PackageManager.under(attrs.packageManager ?? workspace.packageManager, attrs.runtime),
    ["vitest", "run", ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
      "--environment", attrs.environment, ...(attrs.coverage ? [] : ["--coverage.enabled=false"]),
      ...(attrs.passWithNoTests ? ["--passWithNoTests"] : [])]
  )
  if (attrs.shell !== undefined) return ["/bin/sh", "-c", attrs.shell]
  if (attrs.script !== undefined) return ["script", attrs.script.path]
  if (attrs.command !== undefined) return [attrs.command, ...(attrs.args ?? [])]
  return [metadata.target]
}

export async function resolveInventory() {
  const workflow = parseWorkflow(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"))
  const index = await openPackageIndex({ workspace: root })
  const selections = new Map()
  // CI reports already carry effective metadata. Reuse it only for the exact
  // label, rule and content key returned by a later CLI plan. Source or mode
  // changes therefore still require fresh metadata and the same key check.
  const metadata = new Map()
  const metadataIdentity = (target) => JSON.stringify([
    target.label, target.rule ?? target.target, target.key ?? target.keyPreview
  ])
  const selectionErrors = []
  const rows = []
  const planner = createPlanner()
  try {
    // Every real command is planned, including aggregate CI, build, test, docs and lint.
    // Advisory model reviews are excluded: their planning can resolve remote git refs.
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      if ([true, "true"].includes(job["continue-on-error"])) continue
      for (const step of job.steps ?? []) {
        const invocation = targetInvocation(step.run)
        if (!invocation) continue
        const { verb, pattern } = invocation
        const identity = `${verb} ${pattern}`
        if (!selections.has(identity)) {
          console.error(`Resolving CI selection: ${identity}`)
          try {
            const started = performance.now()
            const plan = await planner.plan(verb, pattern, root)
            const cliDurationMs = performance.now() - started
            // The CLI's package report deliberately omits declaration attrs.
            // Re-plan only when earlier selections have not supplied metadata
            // for these exact keys, including anonymous dependency nodes.
            const needsMetadata = plan.targets.some((target) =>
              target.attrs === undefined && !metadata.has(metadataIdentity(target)))
            const native = needsMetadata
              ? await PackageExec.plan({ index, verb, patterns: [pattern], cacheDirectory: index.workspace.cache.directory })
              : undefined
            const targets = plan.targets.map((target) => {
              if (target.attrs !== undefined) return target
              const node = metadata.get(metadataIdentity(target)) ?? native?.nodes.get(target.label)
              if (node === undefined || metadataIdentity(node) !== metadataIdentity(target))
                throw new Error(`CLI plan disagrees with package metadata: ${target.label}`)
              return { ...node, ...target }
            })
            for (const target of targets) metadata.set(metadataIdentity(target), target)
            console.error(JSON.stringify({ ciSelection: identity, cliDurationMs,
              metadataDurationMs: performance.now() - started - cliDurationMs, replannedMetadata: needsMetadata }))
            selections.set(identity, { roots: plan.roots, targets })
          } catch (error) {
            // Retain the other real selections for diagnosis; neither this CLI
            // nor the repo-contract test can pass with an unresolved command.
            selectionErrors.push({ command: identity, error: String(error) })
            selections.set(identity, { roots: [], targets: [] })
          }
        }
        const plan = selections.get(identity)
        const platforms = job.strategy?.matrix?.include ?? [{ os: job["runs-on"], advisory: false }]
        // Read setup-node's pinned release from its version file as well as inline versions.
        const runtimes = job.steps.flatMap((entry) =>
          entry.with?.["node-version"] ? [`Node ${entry.with["node-version"]}`]
            : entry.with?.["node-version-file"]
              ? [`Node ${readFileSync(resolve(root, entry.with["node-version-file"]), "utf8").trim()}`]
              : entry.with?.["bun-version"] ? [`Bun ${entry.with["bun-version"]}`] : [])
        if (job.steps.some((entry) => entry.run?.includes("rustup toolchain install"))) {
          const channel = readFileSync(resolve(root, "rust-toolchain.toml"), "utf8").match(/channel\s*=\s*"([^"]+)"/)?.[1]
          if (!channel) throw new Error("Rust tier has no pinned channel")
          runtimes.push(`Rust ${channel}`)
        }
        for (const selected of plan.targets) {
          const metadata = selected
          if (metadata === undefined || typeof metadata.target !== "string" || !Array.isArray(metadata.kinds) || metadata.attrs == null)
            throw new Error(`Selected target has no runner metadata: ${selected.label}`)
          const attrs = metadata.attrs
          for (const platform of platforms) rows.push({
            job: jobId, step: step.name, trigger: Object.keys(workflow.on), verb, pattern,
            platform: platform.os, required: ![true, "true"].includes(platform.advisory), runtimes,
            label: selected.label, selectedRoot: plan.roots.includes(selected.label),
            kind: metadata.kinds, rule: metadata.target, runner: selected.argv ?? runnerFor(metadata, index.workspace, verb),
            cwd: metadata.target.startsWith("Cargo.") ? "." : attrs.cwd ?? (selected.label.slice(2).split(":")[0] || "."),
            config: attrs.config ?? attrs.tsconfig ?? null,
            inputs: selected.declaredInputs?.map((input) => input.declaration) ??
              [...(attrs.srcs ?? attrs.sources ?? []), ...(attrs.tests ?? []), ...(attrs.data ?? [])],
            coverage: attrs.coverage ?? null, cacheable: selected.cacheable
          })
        }
      }
    }
    return { schemaVersion: 1, node: process.version, platform: process.platform,
      selectionErrors,
      selections: [...selections].map(([command, plan]) => ({ command, roots: plan.roots })), rows }
  } finally { await planner.close() }
}

if (isMain(import.meta)) {
  const inventory = await resolveInventory()
  const destination = process.argv[2]
  if (destination) {
    mkdirSync(dirname(resolve(destination)), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(inventory, null, 2)}\n`)
  } else console.log(JSON.stringify(inventory, null, 2))
  if (inventory.selectionErrors.length > 0) process.exitCode = 1
}
