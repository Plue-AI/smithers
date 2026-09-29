import assert from "node:assert/strict"
import test from "node:test"
import { mismatches, readManifests, readVersionedManifests, retarget, retargetSource, sourceMismatches, versionedSources, versionedTemplates } from "./set-release-version.mjs"

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
    "template: dependencies.@smthrs/kernel is 0.1.0, expected 1.0.0",
    "template: devDependencies.@smthrs/kernel is workspace:*, expected 1.0.0"
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
    "packages/smithers/flows: version is 0.1.0, expected 0.1.0-next.0",
    "packages/smithers/flows: dependencies.@smthrs/kernel is 0.1.0, expected 0.1.0-next.0",
    "packages/smithers/flows: devDependencies.@smthrs/kernel is workspace:*, expected 0.1.0-next.0"
  ])
  assert.deepEqual(mismatches(entries.slice(1), "0.1.0-next.0"), [])
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
