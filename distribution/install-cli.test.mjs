import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installCLI } from "./install-cli.mjs"

async function contents(root, path = "") {
  const result = {}
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const name = join(path, entry.name)
    if (entry.isDirectory()) Object.assign(result, await contents(root, name))
    else if (entry.isFile()) result[name] = (await readFile(join(root, name))).toString("base64")
  }
  return result
}

test("packed CLI installs have identical metadata in distinct temporary parents and run after staging removal", async () => {
  const roots = await Promise.all([1, 2].map(() => mkdtemp(join(tmpdir(), "cli-install-repro-"))))
  try {
    const trees = await Promise.all(roots.map(async root => {
      const staging = join(root, "staging"), source = join(root, "source"), destination = join(root, "output")
      await mkdir(staging)
      await mkdir(source)
      await mkdir(join(destination, "node_modules/.bin"), { recursive: true })
      await writeFile(join(destination, "node_modules/.bin/stale-cli"), "old executable")
      await writeFile(join(destination, "stale-output"), "old output")
      const dependency = join(root, "dependency")
      await mkdir(dependency)
      await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "@smthrs/repro-dependency", version: "1.0.0", type: "module", exports: "./index.mjs" }))
      await writeFile(join(dependency, "index.mjs"), "export const message = 'release-cli-ok'\n")
      execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", staging], { cwd: dependency, stdio: "pipe" })
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "@smthrs/repro", version: "1.0.0", dependencies: { "@smthrs/repro-dependency": "1.0.0" }, bin: { "repro-cli": "cli.mjs" } }))
      await writeFile(join(source, "cli.mjs"), "#!/usr/bin/env node\nimport { message } from '@smthrs/repro-dependency'\nconsole.log(message)\n", { mode: 0o755 })
      execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", staging], { cwd: source, stdio: "pipe" })
      await installCLI([
        { name: "@smthrs/repro", archive: join(staging, "smthrs-repro-1.0.0.tgz") },
        { name: "@smthrs/repro-dependency", archive: join(staging, "smthrs-repro-dependency-1.0.0.tgz") },
      ], staging, destination)
      await rm(staging, { recursive: true })
      assert.equal(execFileSync(join(destination, "node_modules/.bin/repro-cli"), [], { encoding: "utf8" }), "release-cli-ok\n")
      assert.equal(await readlink(join(destination, "node_modules/.bin/repro-cli")), "../@smthrs/repro/cli.mjs")
      const tree = await contents(destination)
      assert.ok(!tree["node_modules/.bin/stale-cli"])
      assert.ok(!tree["stale-output"])
      for (const [name, body] of Object.entries(tree)) {
        assert.ok(!Buffer.from(body, "base64").includes(Buffer.from(root)), `${name} leaked its temporary installation parent`)
      }
      return tree
    }))
    assert.deepEqual(trees[0], trees[1])
    assert.ok(trees[0]["package-lock.json"], "retain npm's full installation receipt")
    assert.ok(trees[0]["node_modules/.package-lock.json"], "retain npm's hidden installation receipt")
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  }
})

test("a failed packed installation preserves the previous CLI output", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-install-failure-"))
  try {
    const staging = join(root, "staging"), destination = join(root, "output")
    await mkdir(staging)
    await mkdir(destination)
    await writeFile(join(destination, "previous-cli"), "previous release")
    await writeFile(join(staging, "invalid.tgz"), "invalid npm archive")
    await assert.rejects(installCLI([{ name: "@smthrs/repro", archive: join(staging, "invalid.tgz") }], staging, destination), /npm install failed/)
    assert.deepEqual(await readdir(destination), ["previous-cli"])
    assert.equal(await readFile(join(destination, "previous-cli"), "utf8"), "previous release")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
