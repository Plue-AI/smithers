/*
 * The wiring gate: every canary probe is invoked by a workflow, and every
 * workflow is linted.
 *
 * The probes in this directory shipped with unit tests and with nothing in
 * .github/workflows/ that ran any of them. A probe nobody invokes cannot grade
 * a deployment, and its unit tests stay green while it does so. These
 * assertions fail the moment a probe is added without a caller, a caller is
 * deleted, or a workflow file is added outside the actionlint argument list.
 *
 * The probe list is derived from the directory, never restated here. A
 * hardcoded list is the defect this file exists to prevent: it would keep
 * passing after someone adds probe six.
 */
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const canaryDir = fileURLToPath(new URL(".", import.meta.url))
const workflowsDir = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url))

const readWorkflow = (name: string): string => readFileSync(`${workflowsDir}${name}`, "utf8")

const workflowNames = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml")).sort()

interface WorkflowStep {
  readonly id?: string
  readonly name?: string
  readonly if?: unknown
  readonly uses?: string
  readonly run?: string
  readonly with?: { readonly name?: string; readonly args?: string }
  readonly env?: Record<string, unknown>
}

interface CiJob {
  readonly if?: unknown
  readonly steps?: ReadonlyArray<WorkflowStep>
}

interface CiWorkflow {
  readonly on?: { readonly push?: { readonly branches?: ReadonlyArray<string> } | null }
  readonly jobs: Record<string, CiJob>
}

interface DeployJob {
  readonly needs?: string | ReadonlyArray<string>
  readonly environment?: string
  readonly steps: ReadonlyArray<WorkflowStep & { readonly with?: Record<string, unknown> }>
}

interface DeployWorkflow {
  readonly on: { readonly push?: { readonly branches?: ReadonlyArray<string>; readonly tags?: ReadonlyArray<string> } }
  readonly concurrency?: unknown
  readonly jobs: Record<string, DeployJob> & { readonly gate: DeployJob; readonly deploy: DeployJob }
}

/** Every `smthrs build|test|ci '<label>'` a job runs, as the label. */
const appTargets = (job: DeployJob): ReadonlyArray<string> =>
  job.steps.flatMap((step) => [...(step.run ?? "").matchAll(/smthrs (?:build|test|ci) '([^']+)'/g)].map((match) => match[1]!))

/*
 * The one job-level `if:` that is not a skipped gate: the cache publisher's
 * push guard. `cache-publish` is the only job handed the cache write
 * credential, and the guard is what keeps that credential out of pull-request
 * runs (packages/smithers/build/infra/CACHE-TRUST.md). GithubCiGen renders it
 * from the workflow's push branches, `missingGates` refuses a gate only the
 * publisher performs, and the root PACKAGE.ts leaves the publisher out of
 * `requiredJobs`, so the guard cannot make a required check disappear.
 * scripts/test/ci.test.ts carves out the same job. Both halves are read from
 * the workflow: the guard must be exactly the declared push branches, and the
 * job must hold the write credential.
 */
const publishGuard = (workflow: CiWorkflow): string | undefined => {
  const refs = (workflow.on?.push?.branches ?? []).map((branch) => `github.ref == 'refs/heads/${branch}'`)
  if (refs.length === 0) return undefined
  return `\${{ github.event_name == 'push' && ${refs.length === 1 ? refs[0] : `(${refs.join(" || ")})`} }}`
}
const holdsCacheWriteCredential = (job: CiJob): boolean =>
  (job.steps ?? []).some((step) => step.env?.SMITHERS_CACHE_WRITE_TOKEN === "${{ secrets.SMITHERS_CACHE_WRITE_TOKEN }}")

const evidenceNames = ["ci-test-tier-evidence", "apps-e2e-artifacts"]
const evidenceFinalizer = (step: WorkflowStep): boolean =>
  step.if === "always()" && evidenceNames.some((name) =>
    step.name === `Collect ${name}`
      ? typeof step.run === "string" && step.uses === undefined
      : step.name === `Upload ${name}` && step.run === undefined &&
        /^actions\/upload-artifact@/.test(step.uses ?? "") && step.with?.name === name
  )

/**
 * The guard GithubCiGen puts on every target step so a red gate does not skip
 * the independent gates after it. It skips only when the job's unconditional
 * `setup` step (the last setup step) did not succeed, and the job is red then.
 */
const independentGate = "${{ !cancelled() && steps.setup.conclusion == 'success' }}"

const guardedBySetup = (steps: ReadonlyArray<WorkflowStep>, index: number): boolean => {
  const setup = steps.findIndex((step) => step.id === "setup")
  return steps[index]!.if === independentGate && setup !== -1 && setup < index && steps[setup]!.if === undefined
}

/** Conditional evidence retention cannot make a validation job or step disappear. */
const conditionalEnforcement = (source: string): ReadonlyArray<string> => {
  const workflow = Bun.YAML.parse(source) as CiWorkflow
  const guard = publishGuard(workflow)
  const violations: string[] = []
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const publisher = guard !== undefined && job.if === guard && holdsCacheWriteCredential(job)
    if (job.if !== undefined && !publisher) violations.push(`${name}: conditional job`)
    const steps = job.steps ?? []
    for (const [index, step] of steps.entries()) {
      if (step.if !== undefined && !evidenceFinalizer(step) && !guardedBySetup(steps, index)) {
        violations.push(`${name}: ${step.name ?? `step ${index + 1}`}`)
      }
    }
  }
  return violations
}

/*
 * An entry point reads process.argv; a library does not. That is the same
 * split the files themselves document — BuildStamp.ts, workers-manifest.ts,
 * and rollback-verdict.ts hold verdicts, and the *-probe.ts
 * shells hold the process.
 */
const entryPoints = readdirSync(canaryDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .filter((name) => readFileSync(`${canaryDir}${name}`, "utf8").includes("process.argv"))
  .sort()

describe("canary probes are wired into a gate", () => {
  it("finds the probe entry points", () => {
    // A guard on the guard: an import rename that empties this list would
    // make every assertion below vacuous.
    expect(entryPoints.length).toBeGreaterThanOrEqual(5)
    expect(entryPoints).toContain("build-probe.ts")
    expect(entryPoints).toContain("workers-health.ts")
    expect(entryPoints).toContain("uptime-probe.ts")
    expect(entryPoints).toContain("rollback-probe.ts")
  })

  it("invokes liveness probes from a workflow or the shared rollout; keeps rollback diagnostic read-only", () => {
    const workflows = workflowNames.map((name) => ({ name, text: readWorkflow(name) }))
    // rollback-probe.ts is now the standalone diagnostic; rollout verifies its pinned target directly.
    const unwired = entryPoints.filter(
      (probe) => probe !== "rollback-probe.ts" &&
        !readFileSync(new URL("../rollout.ts", import.meta.url), "utf8").includes(`scripts/canary/${probe}`) &&
        !workflows.some((workflow) => workflow.text.includes(`scripts/canary/${probe}`))
    )
    expect(unwired).toEqual([])
  })

  it("delegates publication and required checks to the deploy command", () => {
    const deploy = Bun.YAML.parse(readWorkflow("apps-deploy.yml")) as DeployWorkflow
    expect(deploy.jobs.deploy.steps.find(step => step.id === "deploy_real")?.run).toBe("pnpm --filter smithers-server run deploy")
    expect(deploy.jobs.deploy.steps.some(step => step.run?.includes("scripts/canary/"))).toBe(false)
    const source = readFileSync(new URL("../deploy.ts", import.meta.url), "utf8")
    expect(source).toContain("rollout(workerRolloutHost(")
    expect(source).toContain("return { version: versionId, revision: gitSha }")
  })

  /*
   * The deploy was tag-triggered and nobody cut a tag, so the gated path never
   * ran while a laptop hook published every local commit ungated. Every push to
   * main deploys now, behind the same apps targets CI runs, and only the
   * deploy job holds the production credential.
   */
  it("deploys every push to main behind the apps gates CI runs", () => {
    const deploy = Bun.YAML.parse(readWorkflow("apps-deploy.yml")) as DeployWorkflow
    expect(deploy.on.push?.branches).toEqual(["main"])
    expect(deploy.on.push?.tags).toBeUndefined()
    expect(deploy.concurrency).toEqual({ group: "apps-deploy", "cancel-in-progress": false })
    expect([deploy.jobs.deploy.needs].flat()).toContain("gate")
    expect(deploy.jobs.deploy.environment).toBe("production")
    expect(deploy.jobs.gate.environment).toBeUndefined()
    // The ancestry check in scripts/deploy.ts needs origin/main's history.
    expect(deploy.jobs.deploy.steps[0]?.with?.["fetch-depth"]).toBe(0)
    expect(JSON.stringify(deploy.jobs.gate)).not.toContain("CLOUDFLARE_API_TOKEN")

    const ci = Bun.YAML.parse(readWorkflow("ci.yml")) as DeployWorkflow
    const appsE2e = appTargets(ci.jobs["apps-e2e"]!)
    expect(appsE2e.length).toBeGreaterThanOrEqual(4)
    const gate = appTargets(deploy.jobs.gate)
    expect(appsE2e.filter((target) => !gate.includes(target))).toEqual([])
    for (const target of ["//apps/server/...", "//apps/site/..."]) expect(gate).toContain(target)
    expect(JSON.stringify(deploy)).not.toContain("continue-on-error")
  })

  it("passes no retired identity probe inputs and always retains rollback evidence", () => {
    const deploy = Bun.YAML.parse(readWorkflow("apps-deploy.yml")) as DeployWorkflow
    const steps = deploy.jobs.deploy.steps
    const restore = steps.find(step => step.name === "Restore rollback receipt")!
    expect(restore.run).toBe("bun apps/server/scripts/rollout-receipt.ts")
    expect(steps.indexOf(restore)).toBeLessThan(steps.findIndex(step => step.id === "deploy_real"))
    const dry = steps.find(step => step.id === "deploy_dry")!
    expect(dry.env).toBeUndefined()
    expect(readFileSync(new URL("../deploy.ts", import.meta.url), "utf8")).toContain("rehearsalChecks = await dryRunChecks(")
    const real = steps.find(step => step.id === "deploy_real")!
    expect(Object.keys(real.env ?? {}).sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"])
    const upload = steps.find(step => step.with?.name === "deploy-receipt")!
    expect(upload.if).toBe("always()")
    expect(upload.with?.path).toBe("apps/server/deploy-receipts/**/*.json")
  })

  it("lints every workflow file in ci.yml's actionlint step", () => {
    // Parsed, not text-matched: GithubCiGen quotes every mapping key
    // (`"args":`), and the quoting is the generator's business, not this test's.
    const ci = Bun.YAML.parse(readWorkflow("ci.yml")) as CiWorkflow
    const args = Object.values(ci.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("docker://rhysd/actionlint") === true)?.with?.args
    expect(args).toBeDefined()
    const unlinted = workflowNames.filter((name) => !(args as string).includes(`.github/workflows/${name}`))
    expect(unlinted).toEqual([])
  })

  it("keeps CI enforcement unconditional while retaining evidence after failure (issue #176)", () => {
    // Match the coverage-isolation policy: the four named evidence finalizers
    // run after a red gate, while validation jobs and steps cannot be skipped.
    expect(conditionalEnforcement(readWorkflow("ci.yml"))).toEqual([])
  })

  it("rejects skipped gates and conditions disguised as evidence retention", () => {
    expect(conditionalEnforcement(`
jobs:
  checks:
    steps:
      - name: Unit tests
        if: false
        run: bun test
      - name: Build
        if: always()
        run: bun build
      - name: Collect ci-test-tier-evidence
        if: failure()
        run: cp report.json evidence/
      - name: Upload apps-e2e-artifacts
        if: always()
        run: bun test
      - name: Collect ci-test-tier-evidence
        if: always()
        run: cp report.json evidence/
      - name: Upload apps-e2e-artifacts
        if: always()
        uses: actions/upload-artifact@pinned
        with:
          name: apps-e2e-artifacts
  skipped:
    if: false
    steps: []
`)).toEqual([
      "checks: Unit tests",
      "checks: Build",
      "checks: Collect ci-test-tier-evidence",
      "checks: Upload apps-e2e-artifacts",
      "skipped: conditional job"
    ])
  })

  it("admits the setup guard only after an unconditional setup step", () => {
    const gate = `        if: \${{ !cancelled() && steps.setup.conclusion == 'success' }}`
    expect(conditionalEnforcement(`
jobs:
  checks:
    steps:
      - name: Install
        id: setup
        run: pnpm install
      - name: Unit tests
${gate}
        run: pnpm test
`)).toEqual([])
    expect(conditionalEnforcement(`
jobs:
  early:
    steps:
      - name: Unit tests
${gate}
        run: pnpm test
      - name: Install
        id: setup
        run: pnpm install
  skippable:
    steps:
      - name: Install
        id: setup
        if: false
        run: pnpm install
      - name: Unit tests
${gate}
        run: pnpm test
  widened:
    steps:
      - name: Install
        id: setup
        run: pnpm install
      - name: Unit tests
        if: \${{ steps.setup.conclusion == 'success' || github.event_name == 'push' }}
        run: pnpm test
`)).toEqual([
      "early: Unit tests",
      "skippable: Install",
      "skippable: Unit tests",
      "widened: Unit tests"
    ])
  })

  it("admits only the cache publisher's push guard, and nothing that borrows or widens it", () => {
    const workflow = (jobs: string): string => `
on:
  push:
    branches: [main]
  pull_request:
jobs:
${jobs}`
    const writeStep = `    steps:
      - name: Workspace targets
        run: pnpm exec smthrs ci '//packages/...'
        env:
          SMITHERS_CACHE_WRITE_TOKEN: "\${{ secrets.SMITHERS_CACHE_WRITE_TOKEN }}"`
    const readStep = `    steps:
      - name: Workspace targets
        run: pnpm exec smthrs ci '//packages/...'`
    const mainGuard = `    if: \${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`

    expect(conditionalEnforcement(workflow(`  publish:\n${mainGuard}\n${writeStep}`))).toEqual([])
    expect(conditionalEnforcement(workflow([
      // The guard on a job without the write credential: an ordinary gate that skips on every pull request.
      `  borrowed:\n${mainGuard}\n${readStep}`,
      // The write credential on every push, not only the declared branch.
      `  wide:\n    if: \${{ github.event_name == 'push' }}\n${writeStep}`,
      // The write credential guarded to a branch the workflow never pushes.
      `  elsewhere:\n    if: \${{ github.event_name == 'push' && github.ref == 'refs/heads/release' }}\n${writeStep}`
    ].join("\n")))).toEqual([
      "borrowed: conditional job",
      "wide: conditional job",
      "elsewhere: conditional job"
    ])
  })
})
