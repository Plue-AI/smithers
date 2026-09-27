import * as Yaml from "yaml"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { readWorkspaceInventory } from "../readWorkspaceInventory.ts"

/** The workflow fields whose values form the CI contract. */
interface CiStep {
  readonly name?: string
  readonly run?: string
  readonly uses?: string
  readonly if?: string
  readonly env?: Readonly<Record<string, string>>
  readonly with?: Readonly<Record<string, string>>
}
interface CiJob {
  readonly name?: string
  readonly if?: string
  readonly environment?: string
  readonly steps: ReadonlyArray<CiStep>
  readonly strategy?: unknown
  readonly "runs-on"?: string
  readonly "timeout-minutes"?: number
  readonly "continue-on-error"?: boolean | string
}
const readCi = (): { readonly on: Readonly<Record<string, unknown>>; readonly jobs: Readonly<Record<string, CiJob>> } =>
  Yaml.parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"))

describe("ci conformance", () => {
  it("keeps cache write credentials out of every pull-request job", () => {
    const ci = readCi()
    assert.doesNotMatch(JSON.stringify(ci), /secrets\.SMITHERS_CACHE_TOKEN\b/)
    const publishers = Object.entries(ci.jobs).filter(([, job]) =>
      JSON.stringify(job).includes("secrets.SMITHERS_CACHE_WRITE_TOKEN"))
    assert.equal(publishers.length, 1)
    assert.equal(publishers[0]![0], "cache-publish")
    assert.equal(publishers[0]![1].if, "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}")
    // The guard only decides whether the job starts. GitHub withholds an
    // environment secret from any ref the environment's branch policy does
    // not admit, so an edited workflow on a branch cannot read the credential.
    assert.equal(publishers[0]![1].environment, "cache-publish")
    for (const [id, job] of Object.entries(ci.jobs)) {
      for (const step of job.steps) {
        if (!step.run?.startsWith("pnpm exec smthrs")) continue
        assert.equal(step.env?.SMITHERS_CACHE_READ_TOKEN, "${{ secrets.SMITHERS_CACHE_READ_TOKEN }}")
        if (id === "cache-publish") continue
        assert.doesNotMatch(JSON.stringify(step), /SMITHERS_CACHE_WRITE_TOKEN|SMITHERS_CACHE_TOKEN/)
        assert.equal(step.env?.SMITHERS_CACHE_NAMESPACE, "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || '' }}")
      }
    }
    const release = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")
    assert.match(release, /secrets\.SMITHERS_CACHE_READ_TOKEN/)
    assert.doesNotMatch(release, /SMITHERS_CACHE_(?:WRITE_)?TOKEN/)
    const workspace = readFileSync(new URL("../../.smithers/WORKSPACE.ts", import.meta.url), "utf8")
    assert.match(workspace, /read: S.Secret\("SMITHERS_CACHE_READ_TOKEN"\)/)
    assert.match(workspace, /write: S.Secret\("SMITHERS_CACHE_WRITE_TOKEN"\)/)
  })

  it("runs no workflow with base-repository secrets on pull-request code", () => {
    // `pull_request_target` runs with the base repository's secrets and a
    // write token; checking out the pull request's head there hands both to
    // code nobody has reviewed. No workflow in this repository uses it.
    const workflows = new URL("../../.github/workflows/", import.meta.url)
    for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
      assert.doesNotMatch(readFileSync(new URL(file, workflows), "utf8"), /pull_request_target|workflow_run/, file)
    }
  })

  const { packagesDir, packages } = readWorkspaceInventory()
  for (const entry of packages.map((name) => ({ name }))) {
    it(`${entry.name} retains a real Vitest test script (issue #158)`, () => {
      const { name } = entry

      // The recursive developer entry point must retain the package's own
      // config and coverage gate. CI selects PACKAGE.ts test targets; its
      // actual pattern and target runner are checked separately.
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly scripts?: Record<string, string>
      }
      assert.match((manifest.scripts?.test)!, /^vitest(?: run)?$/, `packages/${name}/package.json scripts.test`)
    })
  }

  it("pins the root workspaces globs to the conformance universe (issue #154)", () => {
    // The universe above is derived from `packages/`; that is complete only
    // while `packages/*` is the WHOLE workspace. A second glob (`apps/*`)
    // would ship its packages with no coverage gate at all while every cell
    // here stayed green — the #148 defect reinstated silently. Adding a
    // workspace root means widening this assertion AND the universe
    // derivation above, in review.
    //
    // Widened once, deliberately: `examples` is a private, unpublished
    // workspace of runnable documentation programs. It ships no `src` tree
    // and no coverage gate, and the universe derivation above still reads
    // `packages/` only, so it adds no ungated publishable surface. It is a
    // workspace so its end-to-end suite resolves the real `@smthrs/*`
    // packages and runs under the root `pnpm test` fan-out.
    // Widened a second time, deliberately (2026-08-15, smithers build absorption):
    // `packages/smithers/build/infra` is the hosted cache Cloudflare Worker that ships
    // inside the `smithers-build` package. It is private and unpublished, and it is a
    // workspace member only so its own vitest suite and `tsc --noEmit` run under
    // the root fan-out instead of being dead code. It is NESTED under
    // `packages/smithers/build`, so the `packages/` universe derivation above — which
    // reads top-level directories only — is unaffected and no top-level
    // publishable surface escapes the gate. `sharp` and `workerd` are its
    // wrangler toolchain's postinstall builds, denied like every other.
    // Narrowed again: `e2e` was the fault-injection matrix, widened into this
    // roster by release gate B6 because it was not a member, had no
    // `node_modules`, and `//e2e:faults` failed in 262 ms with
    // `Command "vitest" not found` — eighteen crash, restart, gateway,
    // time-travel, provider, and safety cases that had never run under any
    // gate. Membership is not what a case needs any more: every one of them
    // now lives in the package whose behaviour it asserts, under
    // `test/faults`, where the package's own `node_modules`, `check`, and
    // `faults` target already reach it. `//packages/...:faults` is the matrix.
    // Widened a third time for the deployable applications. `apps/*` contains
    // private entry points rather than published library packages; each app's
    // own test/build scripts participate in the root recursive gates, while
    // the package publication/coverage universe remains `packages/*`.
    // Widened a fifth time: `evals/*` are the evaluation suites. Each one now
    // carries its own private manifest and pins its own `typescript` and
    // `@types/node` instead of resolving whatever the root install hoisted.
    // They are private, unpublished, ship no `src` tree, and sit outside the
    // `packages/` universe derivation above, so they add no ungated
    // publishable surface.
    //
    // Widened a sixth time, and this one adds no surface: `packages/smithers/flows/canonical`
    // is `@smthrs/canonical` nested inside the product package it belongs to, so
    // the hierarchy is visible in the tree. It publishes the same name at the same
    // version to the same dist-tag, and the universe derivation above descends, so
    // it is still held to every assertion here. Membership is spelled out rather
    // than widened to `packages/*/*`: that glob names directories that are not
    // packages, and the gates that read this list one directory deep would stop
    // covering nested members without failing.
    //
    // Widened a seventh time (2026-09-06, release workflows restored): `flows`
    // is `@smithers/release-workflows`, the private, unpublished workspace of
    // the repository's own Smithers programs (release, review, triage, the
    // release-support CLI the root `release:*` scripts call). It ships no
    // `src` tree, is never published, and sits outside the `packages/`
    // universe derivation above, so it adds no ungated publishable surface. It
    // is a member so its `check` and `test` run under the root fan-out and so
    // it resolves the real `@smthrs/*` packages through workspace links.
    const workspace = readFileSync(join(packagesDir, "..", "pnpm-workspace.yaml"), "utf8")
    const packagesBlock = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    assert.equal(
      packagesBlock,
      [
        "packages:",
        "  - \"packages/*\"",
        "  - \"packages/smithers/*\"",
        "  - \"packages/smithers/agent/*\"",
        "  - \"packages/smithers/build/*\"",
        "  - \"packages/smithers/flows/*\"",
        "  - \"packages/smithers/ui/*\"",
        "  - \"examples\"",
        "  - \"flows\"",
        "  - \"apps/*\"",
        "  - \"apps/docs/*\"",
        "  - \"evals/*\"",
        ""
      ].join("\n")
    )

    // The allowBuilds roster is a supply-chain control, not formatting: each
    // entry denies a dependency's postinstall build, and `playwright` is the
    // clearest case — its postinstall downloads browsers, while the live-*
    // checks run against an already-installed one. Denying a build removes
    // ungated surface rather than adding it.
    //
    // This block is asserted on its own rather than as part of an exact match
    // over the whole file. Pinning the entire file made every unrelated
    // addition (`minimumReleaseAgeExclude`, for one) look like a failure here,
    // which is what pressured an earlier change into dropping the roster from
    // the assertion altogether. Flipping any entry to `true` must fail a gate.
    const allowBuilds = workspace.match(/^allowBuilds:\n(?:  .+\n)+/m)?.[0]
    assert.equal(
      allowBuilds,
      [
        "allowBuilds:",
        "  \"@journeyapps/wa-sqlite\": false",
        "  core-js: false",
        "  dprint: false",
        "  es5-ext: false",
        "  esbuild: false",
        "  msgpackr-extract: false",
        "  playwright: false",
        "  sharp: false",
        "  unrs-resolver: false",
        "  vue-demi: false",
        "  workerd: false",
        ""
      ].join("\n")
    )
    assert.match(workspace, /^linkWorkspacePackages: true$/m)
    assert.match(workspace, /^verifyDepsBeforeRun: false$/m)
  })

  it("pins the root aggregator scripts CI invokes (issue #166)", () => {
    // The per-package `scripts.test` pin (issue #158) covered the leaves but
    // not the root: CI runs `pnpm test`, and the root aggregator is what fans
    // that out across every workspace. Narrowing it — e.g. to
    // `--workspace packages/smithers/flows` — silently dropped siblings from CI while
    // every per-package cell and the workspaces-glob cell stayed green. The
    // exact aggregator bodies are pinned here; changing how CI fans out
    // means widening this assertion in review.
    //
    // `test:examples` is a named alias for the examples workspace only. The
    // root `test` fan-out already reaches it, so the alias is a documentation
    // entry point rather than a second enforcement path.
    //
    // `deploy:dry` is the same shape: a single-workspace alias for the server
    // app's deploy rehearsal. It is not a gate CI fans out, so it neither adds
    // nor removes enforcement — it is pinned only so the roster stays exact.
    //
    // `dev` is a developer entry point, not a gate: it forwards to the UI
    // workspace's `start` (devkit projection, `vite build --configLoader
    // runner`, `electrobun dev`) so the Electrobun launch lives in one place.
    // `checklist` forwards the UI acceptance checks. `dev` runs nothing in
    // CI and fans nothing out.
    //
    // `test:jsdoc` is the root-level contract for the repository's custom
    // JSDoc rule harness; pinning it here keeps that non-workspace gate from
    // appearing or disappearing without conformance review.
    //
    // `lint:jsdoc` is the operator alias for CI's `//:jsdocTree`: it enforces
    // public-export JSDoc across all three package depths with the root config.
    // Keep its source globs aligned with the target below.
    //
    // `test:e2e` is the macOS developer entry point for the packaged
    // Electrobun lane. It builds a stable bundle and drives that bundle with
    // Bun; CI does not invoke it because the package graph has no macOS host.
    //
    // `target-index` is the operator alias for the write half of
    // `//:targetIndex`. `.smithers/target-index.json` is derived from every
    // PACKAGE.ts, so any lane that adds a target or changes a target's
    // declared inputs re-keys it; run 11763 (main 2722d0e5) failed `checks` on
    // the stale file alone, the third such run that day. The alias exists so
    // the repair is one word rather than a remembered label, and is pinned
    // here so it stays exactly the write half — a second spelling of the drift
    // check would let a stale commit pass.
    //
    // `check:npm-dedupe` is the operator alias for `//scripts:npmDedupe`, the
    // same shape as `browser` and `//scripts:browserContract`. The resolution reads
    // registry metadata, so the target is uncacheable and re-runs regardless,
    // which is the only concession the network costs. The alias is pinned so
    // the roster stays exact, not because it is a second enforcement path.
    //
    // `commit` invokes the repository's checked commit helper and `deploy`
    // delegates to the server workspace. Both are operator aliases, outside
    // the recursive check/test/lint fan-out pinned here.
    //
    // `release:*` are operator entry points into the `flows` workspace's
    // release-support program (release.yml and release-auth.yml call the same
    // module). They run nothing in CI's package-graph gates and fan nothing
    // out, so they neither add nor remove enforcement; they are pinned so the
    // roster stays exact.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>
    }
    assert.deepEqual(root.scripts, {
      browser: "node scripts/browser-check.mjs",
      check: "pnpm --recursive --if-present run check",
      checklist: "pnpm --filter smithers-app run checklist",
      "check:npm-dedupe": "node scripts/check-npm-dedupe.mjs",
      circular: "pnpm --recursive --if-present run circular",
      "deploy:dry": "pnpm --filter smithers-server run deploy:dry",
      "docs:build": "pnpm --filter \"@smithers/docs-*\" --filter \"!@smithers/docs-shared\" -r run build",
      "docs:check":
        "node apps/docs/shared/check-llms.mjs && node apps/docs/shared/gen-sites.mjs --check && node apps/docs/shared/sync-content.mjs --all --check",
      "docs:deploy": "pnpm --filter \"@smithers/docs-*\" --filter \"!@smithers/docs-shared\" -r run deploy",
      "docs:sync": "node apps/docs/shared/sync-content.mjs --all",
      dev: "pnpm --filter smithers-app run start",
      commit: "node scripts/commit.mjs",
      deploy: "pnpm --filter smithers-server run deploy",
      lint: "pnpm --recursive --if-present run lint",
      "target-index": "pnpm exec smthrs target '//:targetIndex' --write",
      "lint:jsdoc":
        "eslint --config eslint.config.js \"packages/*/src/**/*.ts\" \"packages/*/*/src/**/*.ts\" \"packages/*/*/*/src/**/*.ts\" --max-warnings=0",
      "release:answer": "node --experimental-strip-types flows/release-support/main.ts answer",
      "release:content": "node --experimental-strip-types flows/release-support/main.ts release-content",
      "release:status": "node --experimental-strip-types flows/release-support/main.ts status",
      "release:workflow": "node --experimental-strip-types flows/release-support/main.ts release",
      test: "pnpm --recursive --if-present run test",
      tui: "bun apps/tui/src/main.tsx",
      "test:e2e": "bun apps/app/e2e/packaged/run.ts",
      "test:examples": "pnpm --filter @smthrs/examples run test",
      "test:jsdoc": "node --test eslint.jsdoc.test.mjs"
    })
    const targets = readFileSync(join(packagesDir, "..", "PACKAGE.ts"), "utf8")
    const jsdocTree = targets.match(/const jsdocTree = Smithers\.EsLint\(\{([\s\S]*?)\n\}\)/)?.[1]
    assert.notEqual(jsdocTree, undefined)
    const targetGlobs = Array.from(jsdocTree!.matchAll(/Smithers\.glob\("([^"]+)"\)/g), (match) => match[1])
    const scriptGlobs = Array.from(root.scripts!["lint:jsdoc"]!.matchAll(/"([^"]+)"/g), (match) => match[1])
    assert.deepEqual(targetGlobs, scriptGlobs)
  })

  it("pins the CI steps that reach the target graph and the jj install (issue #166)", () => {
    const ci = readCi()
    const steps = Object.values(ci.jobs).flatMap((job) => job.steps)
    const commands = steps.map((step) => step.run)
    assert.ok(steps.some((step) => step.uses === "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86"))
    for (const command of [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm exec smthrs ci '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//scripts/...' --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//scripts:webBundleContract' --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose",
      "pnpm exec smthrs test '//packages/...:faults' --jobs 1 --known-red '.github/ci-known-red.json' --verbose",
      "jj git init --colocate"
    ]) assert.ok(commands.includes(command), command)
    assert.doesNotMatch(JSON.stringify(ci), /\/\/(?:ci\/|e2e:)/)
    for (const id of ["test", "packages"]) {
      assert.ok(ci.jobs[id]!.steps.some((step) => step.uses === "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"))
    }
    const faults = ci.jobs["e2e-faults"]!
    assert.ok(faults.steps.some((step) => step.run?.includes("//packages/...:faults")))
    assert.doesNotMatch(JSON.stringify(faults), /continue-on-error/)
    assert.ok(steps.some((step) => /^jj-cli@\d+\.\d+\.\d+$/.test(step.with?.tool ?? "")))
  })

  it("runs the package suites on every platform as one matrix, with the advisory bit as data", () => {
    const ci = readCi()
    const job = ci.jobs.packages!
    assert.equal(job.name, "package suites (${{ matrix.os }})")
    assert.deepEqual(job.strategy, {
      "fail-fast": false,
      matrix: {
        os: ["ubuntu-latest", "macos-latest", "windows-latest"],
        include: [
          { os: "ubuntu-latest", advisory: false },
          { os: "macos-latest", advisory: true },
          { os: "windows-latest", advisory: true }
        ]
      }
    })
    assert.equal(job["runs-on"], "${{ matrix.os }}")
    assert.equal(job["timeout-minutes"], 60)
    assert.equal(job["continue-on-error"], "${{ matrix.advisory }}")
    assert.equal(Object.values(ci.jobs).flatMap((row) => row.steps)
      .filter((step) => step.run?.startsWith("pnpm exec smthrs test '//packages/...'")).length, 1)
    assert.ok(!Object.hasOwn(ci.jobs, "node-macos"))
    assert.ok(!Object.hasOwn(ci.jobs, "node-windows"))
  })

  it("keeps every CI step a target invocation, never a hand-written command", () => {
    const commands = Object.values(readCi().jobs).flatMap((job) => job.steps)
      .flatMap((step) => step.run === undefined || step.run.includes("\n") ? [] : [step.run])
    assert.ok(commands.length > 0)
    const derived = [
      /^pnpm exec smthrs (?:build|test|lint|docs|review|ci) '\/\/[^']*'( --jobs \d+)?( --known-red '\.github\/ci-known-red\.json')? --verbose$/,
      /^pnpm install --frozen-lockfile --ignore-scripts$/,
      /^rustup toolchain install$/,
      /^jj git init --colocate$/
    ]
    assert.deepEqual(commands.filter((command) => !derived.some((shape) => shape.test(command))), [])
  })

  it("pins the CI triggers and forbids step conditions on enforcement (issue #176)", () => {
    const ci = readCi()
    assert.deepEqual(ci.on.push, { branches: ["main"] })
    assert.ok(Object.hasOwn(ci.on, "pull_request"))
    for (const [id, job] of Object.entries(ci.jobs)) {
      assert.equal(job.if, id === "cache-publish"
        ? "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"
        : undefined)
      for (const step of job.steps) {
        const artifact = /^(?:Collect|Upload) (?:ci-test-tier-evidence|apps-e2e-artifacts)$/.test(step.name ?? "")
        // A gate runs after an earlier red gate, never after failed setup (#2071).
        const gate = step.run?.startsWith("pnpm exec smthrs ") === true
        assert.equal(
          step.if,
          artifact ? "always()" : gate ? "${{ !cancelled() && steps.setup.conclusion == 'success' }}" : undefined
        )
      }
    }
  })
})
