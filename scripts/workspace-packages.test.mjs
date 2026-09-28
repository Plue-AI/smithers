import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { test } from "node:test"
import { repoRoot, workspacePackages } from "./workspace-packages.mjs"

const script = join(repoRoot, "scripts", "workspace-packages.mjs")

const run = (entry, cwd) => execFileSync(process.execPath, [entry], { cwd, encoding: "utf8", timeout: 30_000 })

for (const patterns of [["packages/*", "!packages/omitted"], ["!packages/omitted", "packages/*"]]) {
  test(`workspace membership respects exclusions in ${JSON.stringify(patterns)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-workspace-exclusion-"))
    try {
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n" + patterns.map((pattern) => `  - ${JSON.stringify(pattern)}\n`).join(""))
      for (const name of ["kept", "omitted"]) {
        const directory = join(root, "packages", name)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0" }))
      }
      assert.deepEqual(workspacePackages(root), [{
        dir: "packages/kept",
        name: "@fixture/kept",
        manifestPath: join(root, "packages/kept/package.json"),
        manifest: { name: "@fixture/kept", version: "1.0.0" }
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const [label, patterns, expected] of [
  ["positive negated extglob follows pnpm prefix matching", ["packages/!(skip)"], ["packages/keep"]],
  ["escaped positive bang selects a literal directory", ["\\!packages/**"], ["!packages/skip"]],
  ["positive extglob alternatives", ["packages/@(keep|skip)"], ["packages/keep", "packages/skip"]],
  ["positive brace alternatives", ["packages/{keep,skip}"], ["packages/keep", "packages/skip"]],
  ["exact directory preserves descendants", ["packages/**", "!packages/skip"], ["packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip-other", "packages/skip/child"]],
  ["subtree removes its anchor and descendants", ["packages/**", "!packages/skip/**"], ["packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip-other"]],
  ["direct children preserve the parent", ["packages/**", "!packages/skip/*"], ["packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip", "packages/skip-other"]],
  ["nested exclusion", ["packages/**", "!**/test/**"], ["packages/a/ok", "packages/keep", "packages/skip", "packages/skip-other", "packages/skip/child"]],
  ["overlap cannot reinclude an excluded member", ["!packages/skip", "packages/*", "packages/skip"], ["packages/keep", "packages/skip-other"]],
  ["negative-only list does not implicitly include root", ["!packages/skip"], []],
  ["leading negated extglob remains a positive selector", ["!(outside)/*"], ["!!packages/skip", "!packages/skip", "packages/keep", "packages/skip", "packages/skip-other"]],
  ["doubled marker does not reinclude or exclude", ["packages/*", "!!packages/skip"], ["packages/keep", "packages/skip", "packages/skip-other"]],
  ["doubled marker preserves literal bang directories", ["{packages,!packages,!!packages}/**", "!!packages/skip"], ["!!packages/skip", "!packages/skip", "packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip", "packages/skip-other", "packages/skip/child"]],
  ["tripled marker preserves literal bang directories", ["{packages,!packages,!!packages}/**", "!!!packages/skip"], ["!!packages/skip", "!packages/skip", "packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip", "packages/skip-other", "packages/skip/child"]],
  ["escaped bang exclusion", ["{packages,!packages,!!packages}/**", "!\\!packages/skip"], ["!!packages/skip", "packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip", "packages/skip-other", "packages/skip/child"]],
  ["brace exclusions", ["packages/*", "!packages/{skip,keep}"], ["packages/skip-other"]],
  ["trailing slashes", ["packages/*/", "!packages/skip/"], ["packages/keep", "packages/skip-other"]],
  ["relative prefix and overlapping descendants", ["./packages/**", "packages/skip/child", "!./packages/skip"], ["packages/a/ok", "packages/a/test/one", "packages/keep", "packages/skip-other", "packages/skip/child"]]
]) {
  test(`workspace exclusions: ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-workspace-exclusion-boundary-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "@fixture/root", private: true }))
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n" + patterns.map((pattern) => `  - '${pattern}'\n`).join(""))
      const directories = ["packages/keep", "packages/skip", "packages/skip/child", "packages/skip-other", "packages/a/test/one", "packages/a/ok", "!packages/skip", "!!packages/skip"]
      for (const [index, directory] of directories.entries()) {
        await mkdir(join(root, directory), { recursive: true })
        await writeFile(join(root, directory, "package.json"), JSON.stringify({ name: `@fixture/member-${index}`, version: "1.0.0" }))
      }
      assert.deepEqual(workspacePackages(root).map((entry) => entry.dir), expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("workspace inventory retains JSON-only members and skips dependency trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-workspace-manifests-"))
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/**'\n")
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "root" }))
    for (const [directory, filename, contents] of [
      ["packages/kept", "package.json", '{"name":"kept"}'],
      ["packages/yaml-only", "package.yaml", 'name: yaml-only\n'],
      ["packages/json5-only", "package.json5", '{name: "json5-only"}'],
      ["packages/kept/node_modules/dependency", "package.json", '{"name":"dependency"}'],
      ["packages/kept/bower_components/dependency", "package.json", '{"name":"bower"}']
    ]) {
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(join(root, directory, filename), contents)
    }
    assert.deepEqual(workspacePackages(root).map(({ dir, name }) => ({ dir, name })), [{ dir: "packages/kept", name: "kept" }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the entry-point guard runs main under a symlinked, space-containing, or relative invocation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers entry ")))
  try {
    const expected = run(script, repoRoot)
    assert.match(expected, /^packages\//m)
    const linked = join(root, "linked workspace-packages.mjs")
    await symlink(script, linked)
    assert.equal(run(linked, root), expected)
    assert.equal(run(relative(root, script), root), expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
