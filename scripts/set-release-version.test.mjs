import assert from "node:assert/strict"
import test from "node:test"
import { changelogMismatches, mismatches, readManifests, readVersionedManifests, releaseChangelog, retarget, retargetSource, sourceMismatches, versionedChangelogs, versionedSources, versionedTemplates } from "./set-release-version.mjs"

const workspaceNames = new Set(["@smthrs/kernel", "@smthrs/flows"])

const example = {
  name: "@smthrs/flows",
  version: "0.1.0",
  dependencies: {
    "@smthrs/kernel": "0.1.0",
    effect: "4.0.0-rc.115"
  },
  devDependencies: {
    "@smthrs/kernel": "workspace:*",
    vitest: "5.0.0"
  }
}

test("retarget moves the version and the exact workspace ranges together", () => {
  assert.deepEqual(retarget(example, "0.1.0-next.0", workspaceNames), {
    name: "@smthrs/flows",
    version: "0.1.0-next.0",
    dependencies: {
      "@smthrs/kernel": "0.1.0-next.0",
      effect: "4.0.0-rc.115"
    },
    devDependencies: {
      "@smthrs/kernel": "0.1.0-next.0",
      vitest: "5.0.0"
    }
  })
  assert.equal(example.version, "0.1.0")
})

test("retarget leaves third-party ranges alone", () => {
  const retargeted = retarget(example, "9.9.9", new Set())
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0")
  assert.equal(retargeted.version, "9.9.9")
})

test("retarget preserves private versions while updating exact workspace ranges", () => {
  const privateManifest = { ...example, private: true, version: "0.0.0" }
  const retargeted = retarget(privateManifest, "0.1.0-next.0", workspaceNames)
  assert.equal(retargeted.version, "0.0.0")
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0-next.0")
  assert.equal(retargeted.devDependencies["@smthrs/kernel"], "workspace:*")
})

test("a private shipped template requires registry versions even for a workspace protocol", () => {
  const manifest = { ...example, private: true, version: "0.0.0" }
  const updated = retarget(manifest, "1.0.0", workspaceNames, { registryDependencies: true })
  assert.equal(updated.version, "0.0.0")
  assert.equal(updated.devDependencies["@smthrs/kernel"], "1.0.0")
  const entries = [
    { directory: "template", manifest, registryDependencies: true },
    { directory: "kernel", manifest: { name: "@smthrs/kernel", version: "1.0.0" } }
  ]
  assert.deepEqual(mismatches(entries, "1.0.0"), [
    "template/package.json: dependencies.@smthrs/kernel is 0.1.0, expected 1.0.0",
    "template/package.json: devDependencies.@smthrs/kernel is workspace:*, expected 1.0.0"
  ])
})

test("mismatches names the version and every stale internal range", () => {
  const entries = [
    { directory: "packages/smithers/flows", manifest: example },
    {
      directory: "packages/smithers/flows/kernel",
      manifest: { name: "@smthrs/kernel", version: "0.1.0-next.0" }
    }
  ]

  assert.deepEqual(mismatches(entries, "0.1.0-next.0"), [
    "packages/smithers/flows/package.json: version is 0.1.0, expected 0.1.0-next.0",
    "packages/smithers/flows/package.json: dependencies.@smthrs/kernel is 0.1.0, expected 0.1.0-next.0",
    "packages/smithers/flows/package.json: devDependencies.@smthrs/kernel is workspace:*, expected 0.1.0-next.0"
  ])
  assert.deepEqual(mismatches(entries.slice(1), "0.1.0-next.0"), [])
  assert.deepEqual(mismatches([{ ...entries[0], directory: "packages/smithers/flows/package.json" }, entries[1]], "0.1.0-next.0"),
    mismatches(entries, "0.1.0-next.0"), "a manifest path is not given a second package.json suffix")
})

test("this workspace is internally coherent at its current version", () => {
  const entries = readVersionedManifests()
  const version = entries.find(({ directory }) => directory === "packages/smithers/flows").manifest.version

  assert.deepEqual(mismatches(entries, version), [])
  for (const path of versionedTemplates) {
    assert.equal(entries.find((entry) => entry.directory === path)?.registryDependencies, true)
  }
})

test("workspace discovery follows every pnpm-workspace package glob", () => {
  const directories = new Set(readManifests().map(({ directory }) => directory))
  assert.equal(directories.has("packages/smithers/build/infra"), true)
  assert.equal(directories.has("examples"), true)
  assert.equal(directories.has("apps/server"), true)
  assert.equal(directories.has("packages/rpc"), true)
  assert.equal(directories.has("apps/app"), true)
})

test("retargetSource rewrites the version literal and nothing else", () => {
  const source = versionedSources.find(({ path }) => path.endsWith("Otlp.ts"))
  const text = [
    "/** @since 0.1.0 */",
    'export const defaultServiceVersion = "1.0.0-rc.0"',
    'export const other = "1.0.0-rc.0"'
  ].join("\n")

  assert.equal(
    retargetSource(text, "1.0.0-rc.1", source),
    [
      // A `@since` tag records when the export appeared, not what ships today.
      "/** @since 0.1.0 */",
      'export const defaultServiceVersion = "1.0.0-rc.1"',
      'export const other = "1.0.0-rc.0"'
    ].join("\n")
  )
})

test("the MCP client identity is a versioned source", () => {
  const source = versionedSources.find(({ path }) => path === "packages/smithers/mcp/src/McpClient.ts")
  assert.ok(source, "McpClient.ts clientInfo.version is not in versionedSources")
  const text = [
    "export const clientInfo = Object.freeze({",
    '  name: "smithers",',
    '  version: "1.0.0-rc.0"',
    "})",
    'export const other = "1.0.0-rc.0"'
  ].join("\n")

  assert.equal(
    retargetSource(text, "1.0.0-rc.1", source),
    text.replace('version: "1.0.0-rc.0"', 'version: "1.0.0-rc.1"')
  )
})

test("the storage release policy is a versioned source", () => {
  // Its refusal texts quote the release; the rc.2 and rc.3 bumps left it at rc.1.
  const source = versionedSources.find(({ path }) => path.endsWith("flows/database/src/internal/ReleasePolicy.ts"))
  assert.ok(source, "ReleasePolicy.ts releaseVersion is not in versionedSources")
  const text = ['export const releaseVersion = "1.0.0-rc.1"', 'export const nodeFloor = ">=26.4.0"'].join("\n")

  assert.equal(
    retargetSource(text, "1.0.0-rc.3", source),
    text.replace('releaseVersion = "1.0.0-rc.1"', 'releaseVersion = "1.0.0-rc.3"')
  )
})

test("retargetSource refuses a file that no longer carries the declaration", () => {
  const source = versionedSources.find(({ path }) => path.endsWith("Otlp.ts"))

  assert.throws(
    () => retargetSource("export const somethingElse = \"1.0.0-rc.0\"", "1.0.0-rc.1", source),
    /no longer declares defaultServiceVersion/
  )
})

test("sourceMismatches names a literal the manifests left behind", () => {
  const manifests = readManifests()
  assert.deepEqual(sourceMismatches("9.9.9"), versionedSources.map(({ path, declaration, package: ownerPackage }) => {
    const version = manifests.find((entry) => entry.directory === (ownerPackage ?? path.split("/src/")[0])).manifest.version
    return `${path}: ${declaration} is ${version}, expected 9.9.9`
  }))
})

test("every versioned source agrees with the version its own package declares", () => {
  const entries = readManifests()
  for (const { path, package: ownerPackage } of versionedSources) {
    const directory = ownerPackage ?? path.split("/src/")[0]
    const owner = entries.find((entry) => entry.directory === directory)
    assert.ok(owner, `${path} is not inside a workspace package`)
    assert.deepEqual(sourceMismatches(owner.manifest.version), [])
  }
})

test("the storage docs quote the release through versioned sources, on the package page and its site copy", () => {
  // api.md and troubleshooting.md still said 1.0.0-rc.0 at rc.3: the bump never knew the lines.
  const rows = versionedSources.filter(({ package: owner }) => owner === "packages/smithers/flows/database")
  assert.deepEqual(rows.map(({ path }) => path).sort(), [
    "apps/site/src/content/docs/docs/reference/api/database.mdx",
    "apps/site/src/content/docs/docs/reference/api/database.mdx",
    "apps/site/src/content/docs/docs/reference/api/database.mdx",
    "packages/smithers/flows/database/docs/api.md",
    "packages/smithers/flows/database/docs/api.md",
    "packages/smithers/flows/database/docs/api.md",
    "packages/smithers/flows/database/docs/troubleshooting.md",
    "packages/smithers/flows/database/docs/troubleshooting.md"
  ])
  const text = [
    "ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.0 (use SMITHERS_POSTGRES_URL to select PostgreSQL)",
    "A refusal to open a durable database in 1.0.0-rc.0, raised as a defect rather",
    "| `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)` |",
    "### `1.0.0-rc.0 runs the durable engine on Node.js >=26.4.0 only`"
  ].join("\n")
  const rewritten = rows.reduce((current, row) => row.pattern.test(current) ? retargetSource(current, "1.0.0-rc.10", row) : current, text)
  // "Smithers 1.0 database" names the format, not the release, and stays.
  assert.equal(rewritten, text.replaceAll("1.0.0-rc.0", "1.0.0-rc.10"))
})

test("releaseChangelog moves the unreleased entries under a dated heading for the version", () => {
  const text = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- `Rubric`.",
    "",
    "## [1.0.0-rc.2] - 2026-10-09",
    "",
    "- Earlier.",
    ""
  ].join("\n")
  assert.equal(
    releaseChangelog(text, "1.0.0-rc.3", "2026-10-10"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [1.0.0-rc.3] - 2026-10-10",
      "",
      "### Added",
      "",
      "- `Rubric`.",
      "",
      "## [1.0.0-rc.2] - 2026-10-09",
      "",
      "- Earlier.",
      ""
    ].join("\n")
  )
})

test("releaseChangelog records an unchanged ride, keeps a released file, and refuses one with nothing to release", () => {
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.2] - 2026-10-09\n\n- Earlier.\n"
  const released = releaseChangelog(empty, "1.0.0-rc.3", "2026-10-10")
  assert.equal(
    released,
    "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.3] - 2026-10-10\n\n### Changed\n\n"
      + "- Released with the workspace package train. No change to this package since the previous release.\n\n"
      + "## [1.0.0-rc.2] - 2026-10-09\n\n- Earlier.\n"
  )
  // A second pass at the same version, or a rerun after a failed cut, changes nothing.
  assert.equal(releaseChangelog(released, "1.0.0-rc.3", "2026-10-11"), released)
  // rc.3 is not a prefix match for rc.30.
  assert.notEqual(releaseChangelog(released, "1.0.0-rc.30", "2026-11-01"), released)
  assert.throws(() => releaseChangelog("# Changelog\n\n## [1.0.0-rc.2]\n", "1.0.0-rc.3", "2026-10-10"), /no `## \[Unreleased\]` section/)
})

test("every versioned changelog has a section for the version its package declares", () => {
  const entries = readManifests()
  for (const path of versionedChangelogs) {
    const owner = entries.find((entry) => entry.directory === path.replace(/\/CHANGELOG\.md$/, ""))
    assert.ok(owner, `${path} is not a workspace package's changelog`)
    assert.deepEqual(changelogMismatches(owner.manifest.version), [])
    assert.deepEqual(changelogMismatches("9.9.9"), [`${path}: no \`## [9.9.9]\` section`])
  }
})
