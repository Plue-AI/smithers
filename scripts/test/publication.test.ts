import * as Yaml from "yaml"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { readWorkspaceInventory } from "../readWorkspaceInventory.ts"

describe("publication conformance", () => {
  const { packagesDir, packages } = readWorkspaceInventory()

  // A second named carve-out, and only from the export-shape cell below. The
  // unscoped `smthrs` package is a migration notice whose single module throws
  // on import and exposes only `.`. It still ships a vitest config, `scripts.test`, and the
  // 100% coverage gate, so it is inside every other assertion in this suite.
  const noticeOnlyPackages = new Set(["smthrs-deprecation"])

  for (const entry of packages.map((name) => ({ name }))) {
    it(
      `${entry.name} retains Effect-style source exports and declares built publication exports`,
      () => {
        const { name } = entry

        const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
          readonly private?: boolean
          readonly smthrs?: { readonly group?: string }
          readonly exports?: Record<string, unknown>
          readonly publishConfig?: {
            readonly exports?: Record<string, unknown>
          }
        }
        assert.equal(manifest.exports?.["."], "./src/index.ts")
        if (noticeOnlyPackages.has(name)) {
          assert.equal(manifest.exports?.["./*"], undefined)
          assert.deepEqual(manifest.publishConfig?.exports?.["."], {
            import: { types: "./dist/esm/index.d.ts", default: "./dist/esm/index.js" },
            require: { types: "./dist/cjs/index.d.ts", default: "./dist/cjs/index.js" }
          })
          return
        }
        if (manifest.private !== true) {
          assert.equal(manifest.exports?.["./*"], undefined)
          assert.deepEqual(
            Object.entries(manifest.exports ?? {}).filter(([key, target]) => key.includes("*") && target !== null),
            []
          )
        }
        // A third carve-out, derived rather than named, and only from the
        // publication half of this cell. `scripts/pack-release.mjs:43` skips a
        // manifest that is `private` or outside the `engine` and `agent`
        // release groups, so the build graph, its CLI, and the target library —
        // private, `smthrs.group: "tooling"`, packed by no candidate — have no
        // published surface for a `publishConfig.exports` map to describe.
        // The exemption is conditioned on the two facts that make it
        // true, so it expires by itself: a package that drops `private`, or
        // moves into a release group, falls straight back into the assertion
        // below. Every other private package here (`chain`, `evals`, `fs`,
        // `scorers`, `triggers`, `integrations`, `errors`) is in
        // a release group, kept the map it arrived with, and is still held to
        // its exact shape, so nothing that could be packed reaches this branch.
        const publication = manifest.publishConfig?.exports
        if (publication === undefined && manifest.private === true) {
          assert.equal(
            manifest.smthrs?.group,
            "tooling",
            `packages/${name} declares no publishConfig.exports; only the private tooling group may omit one`
          )
          return
        }
        assert.deepEqual(Object.keys(publication ?? {}).sort(), Object.keys(manifest.exports ?? {}).sort())
        for (const subpath of [".", ...(manifest.exports?.["./*"] === undefined ? [] : ["./*"])]) {
          const target = publication?.[subpath]
          // The shared published-library builder emits declarations for
          // each module format. Private source workspaces retain their old
          // unpublished map; making one public must require both branches
          // so a CommonJS consumer cannot resolve ESM declarations.
          const module = subpath === "." ? "index" : "*"
          assert.deepEqual(
            target,
            manifest.private === true
              ? {
                types: `./dist/esm/${module}.d.ts`,
                import: `./dist/esm/${module}.js`,
                require: `./dist/cjs/${module}.js`
              }
              : {
                import: { types: `./dist/esm/${module}.d.ts`, default: `./dist/esm/${module}.js` },
                require: { types: `./dist/cjs/${module}.d.ts`, default: `./dist/cjs/${module}.js` }
              }
          )
        }
      }
    )
  }

  it("smoke-validates packed artifacts before rerunnable publication", async () => {
    const release = readFileSync(join(packagesDir, "..", ".github", "workflows", "release.yml"), "utf8")
    const smoke = release.indexOf("Pack and smoke-test release artifacts")
    const publish = release.indexOf("Publish packages in dependency order")
    assert.ok(smoke > -1)
    assert.ok(publish > smoke)
    assert.ok(release.includes("node scripts/pack-release.mjs \"$PACK_DIR\""))
    assert.ok(release.includes("node scripts/smoke-release.mjs \"$PACK_DIR\""))
    // Both workflows install the pnpm version pinned once in package.json.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly packageManager?: string
    }
    assert.match(root.packageManager!, /^pnpm@\d+\.\d+\.\d+$/)
    assert.match(release, /^\s*- uses: pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86$/m)
    // release.yml is hand-written, so its own pin is read as text. ci.yml is
    // generated and quotes every scalar, so the same pin is read out of the
    // parsed step: the action a job runs is the contract, not its spelling.
    const ci = Yaml.parse(readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")) as {
      readonly jobs: Readonly<Record<string, { readonly steps: ReadonlyArray<{ readonly uses?: string }> }>>
    }
    assert.ok(
      Object.values(ci.jobs).flatMap((job) => job.steps)
        .some((step) => step.uses === "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86")
    )
    assert.ok(release.includes("node scripts/publish-release.mjs \"$PACK_DIR\""))
    const restore = release.indexOf("Restore and verify archived release candidate")
    assert.ok(restore > smoke)
    assert.ok(publish > restore)
    assert.ok(release.includes("node scripts/restore-release.mjs \"$PACK_DIR\""))
    // The published set and its order are read out of the pack manifest, so a
    // restated package list cannot drift from what was packed. `scripts/
    // pack-release.test.mjs` holds the rest of that conformance suite.
    assert.ok(release.includes("manifest.json"))
    assert.ok(!release.includes("publish_if_missing"))
    const packScript = readFileSync(join(packagesDir, "..", "scripts", "pack-release.mjs"), "utf8")
    const smokeScript = readFileSync(join(packagesDir, "..", "scripts", "smoke-release.mjs"), "utf8")
    const publishScript = readFileSync(join(packagesDir, "..", "scripts", "publish-release.mjs"), "utf8")
    assert.ok(publishScript.includes("join(directory, \"release-manifest.json\")"))
    assert.ok(publishScript.includes("const pending = await preflight(directory, candidate, options)"))
    assert.ok(publishScript.includes("for (const entry of pending)"))
    // Verify the actual registry adapter's invocation, so extracting a helper
    // cannot break this contract while dropping provenance still does.
    const { registryPublisher } = await import(
      pathToFileURL(join(packagesDir, "..", "scripts", "publish-release.mjs")).href
    )
    const calls: Array<readonly [string, ReadonlyArray<string>]> = []
    const publisher = registryPublisher({
      run: (command: string, args: ReadonlyArray<string>) => {
        calls.push([command, args])
        return ""
      }
    })
    publisher.publish("candidate.tgz", { version: "1.0.0" })
    publisher.publish("candidate-rc.tgz", { version: "1.0.0-rc.0" })
    assert.deepEqual(calls, [
      ["pnpm", [
        "publish",
        "candidate.tgz",
        "--provenance",
        "--access",
        "public",
        "--tag",
        "latest",
        "--no-git-checks"
      ]],
      ["pnpm", [
        "publish",
        "candidate-rc.tgz",
        "--provenance",
        "--access",
        "public",
        "--tag",
        "next",
        "--no-git-checks"
      ]]
    ])
    assert.ok(publishScript.includes("[\"view\", spec, \"dist.integrity\", \"--json\"]"))
    assert.ok(publishScript.includes("evidence.candidateIntegrity !== candidateIntegrity(candidate)"))
    assert.ok(packScript.includes("publicationManifest(manifest)"))
    assert.ok(packScript.includes("\"pnpm\","))
    assert.ok(packScript.includes("\"pack\""))
    assert.ok(smokeScript.includes("\"pnpm\","))
    assert.ok(smokeScript.includes("\"add\""))
    assert.ok(smokeScript.includes("for (const entry of packManifest)"))
    assert.ok(smokeScript.includes("await import(${JSON.stringify(entry.name)})"))
    assert.ok(smokeScript.includes("require(${JSON.stringify(entry.name)})"))
    // Validation after publish cannot protect the release that was just
    // exposed. The smoke check and publication live in the same gated job.
    assert.doesNotMatch(release, /^\s+smoke:\s*$/m)
  })
})
