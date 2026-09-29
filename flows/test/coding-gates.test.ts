import * as Target from "@smthrs/targets/Target"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { workspacePackages } from "../../scripts/workspace-packages.mjs"
import { Package } from "../PACKAGE.ts"
import { bunNativeTests, nativeTests } from "./coding-native-gate.mjs"

test("coding gates track source-only groups at every Smithers package boundary", () => {
  const metadata = Target.metadata(Package.codingPolicy)
  const groups = metadata.dependencies.map(Target.metadata).filter((member) => member.target === "Filegroup")
  const backend = groups.filter((member) => (member.attrs as { cwd: string }).cwd.startsWith("packages/smithers"))
  const actual = backend.map((member) => (member.attrs as { cwd: string }).cwd).sort()
  const expected = workspacePackages().map((member) => member.dir)
    .filter((dir) => dir === "packages/smithers" || dir.startsWith("packages/smithers/")).sort()
  assert.deepEqual(actual, expected)
  for (const group of backend) {
    assert.equal(group.dependencies.length, 0, "source groups must not trigger package builds")
    assert.deepEqual(group.inputs, [
      { _tag: "Glob", pattern: "src/**", exclude: [] },
      { _tag: "File", path: "package.json" },
      { _tag: "File", path: "tsconfig.json" }
    ])
  }
  assert.ok(metadata.inputs.some((input) => input._tag === "PnpmWorkspace" && input.path === "//pnpm-workspace.yaml"))
})

// A rebased stack replays these verdicts, so their declarations must name what
// the fixtures read: `coding-host.test.ts` loads the project configuration.
test("the fast coding checks replay unchanged verdicts over their declared inputs", () => {
  for (const target of [Package.codingPolicy, Package.codingRuntime]) {
    const metadata = Target.metadata(target)
    assert.equal(metadata.cacheable, true)
    assert.ok(
      metadata.inputs.some((input) => input._tag === "File" && input.path === "//.smithers/coding-project.json")
    )
    assert.ok(metadata.inputs.some((input) => input._tag === "File" && input.path === "//pnpm-lock.yaml"))
  }
})

// Every fixture under flows/test, not just the coding family. Forty-five of the
// eighty-seven were in no target and in no gate when this claim was widened:
// they ran only under this package's bare `pnpm test`, which no workflow
// invokes, so nothing they asserted could report a regression. Ownership is
// read from the declarations, never from PACKAGE.ts source text, so a target
// that builds its file list stays visible here.
test("every flows fixture belongs to a declared gate; native targets stay separate and uncached", async () => {
  const actual = (await readdir(fileURLToPath(new URL("./", import.meta.url)))).filter((name) =>
    /\.test\.(?:ts|mjs)$/.test(name)
  )
  const ordinary = Object.values(Package).filter((target) => Target.metadata(target).target === "NodeTest")
    .flatMap((target) =>
      (Target.metadata(target).attrs as { runner: { tests?: ReadonlyArray<{ path: string }> } }).runner.tests ?? []
    )
    .map((file) => file.path.split("/").at(-1)!).filter((name) => actual.includes(name))
  // Fixtures a second runtime re-runs, and the two the native gate also owns:
  // `//flows:repository` runs the cases that need no Plue tool, and the gate
  // runs the whole file under the prerequisites the rest of it requires.
  const twice = ordinary.filter((name, index) => ordinary.indexOf(name) !== index).sort()
  assert.deepEqual([...new Set(twice)], [
    "coding-host-modules.test.ts",
    "coding-host-policy.test.ts",
    "coding-landing-config.test.ts",
    "coding-landing.test.ts",
    "coding-project-config.test.ts",
    "coding-source-publication.test.ts",
    "coding-vibe-admission.test.ts",
    "coding-vibe-evidence.test.ts",
    "coding-vibe-landing.test.ts",
    "coding-wiki-registry.test.ts"
  ], "a fixture in two ordinary targets is a declared runtime pair")
  assert.deepEqual([...new Set(ordinary)].filter((name) => nativeTests.includes(name)).sort(), [
    "repository-check-context.test.ts",
    "repository-checks.test.ts"
  ], "dual ownership is declared, not accidental")
  assert.deepEqual([...new Set([...ordinary, ...nativeTests])].sort(), actual.sort())
  for (const target of [Package.codingNative, Package.codingNativeBun, Package.codingBundle, Package.codingBundleBun]) {
    const metadata = Target.metadata(target)
    const attrs = metadata.attrs as { timeout: string; args: string[]; tools: unknown[] }
    assert.equal(metadata.target, "Shell.Test")
    // The JJ and exporter bytes the gate spawns are key material, not host luck.
    assert.deepEqual(attrs.tools, [
      { _tag: "HostBin", name: "jj" },
      { _tag: "HostBin", name: "smithers-jj-export", env: "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" }
    ])
    assert.equal(metadata.cacheable, false)
    assert.equal(attrs.timeout, "45m")
    assert.equal(attrs.args[0], "flows/test/coding-native-gate.mjs")
  }
  assert.ok(!bunNativeTests.includes("repository-check-context.test.ts"))
  assert.ok(bunNativeTests.includes("coding-native.test.ts"))
})

test("native gate refuses absent prerequisites before an opt-in fixture can skip", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./coding-native-gate.mjs", import.meta.url))], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH, SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: "/smithers-acceptance-does-not-exist/helper" }
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Native coding prerequisite is missing/)
  assert.doesNotMatch(result.stdout, /Native coding gate:/)
  // Unset, the helper is found on PATH, as the build resolves it; none is absent.
  const unset = spawnSync(process.execPath, [fileURLToPath(new URL("./coding-native-gate.mjs", import.meta.url))], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: "/smithers-acceptance-does-not-exist" }
  })
  assert.equal(unset.status, 1, unset.stderr)
  assert.match(unset.stderr, /Native coding prerequisite is missing/)
  const unlisted = spawnSync(process.execPath, [
    fileURLToPath(new URL("./coding-native-gate.mjs", import.meta.url)),
    "source",
    "../unlisted.ts"
  ], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH }
  })
  assert.equal(unlisted.status, 1, unlisted.stderr)
  assert.match(unlisted.stderr, /Select an existing source fixture/)
})
