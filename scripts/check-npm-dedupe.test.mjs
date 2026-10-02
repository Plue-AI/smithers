// The dependency policy of combined and individual release consumers.
//
// The script reports both findings through one exit code, so a regression in
// either reads as an opaque non-zero exit. These cells name the claim that
// broke and the package that broke it.
//
// Real release manifests are packed unchanged. The combined fixture inspects
// npm's lockfile, while individual npm and pnpm consumers inspect physical
// files and each installed package's native Effect resolution.
//
// The fixture install reads registry metadata, so this suite needs the network.
//
// Run it with `node --test scripts/check-npm-dedupe.test.mjs`.
import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { SINGLETONS, copiesOf, maxPackagesFrom, optionalPeersOf, resolveConsumerTree, resolveConsumerProfiles } from "./check-npm-dedupe.mjs"
import { assertConsumerTree } from "./release-consumers.mjs"
import { repoRoot } from "./workspace-packages.mjs"

it("refuses a --max-packages value that cannot fail", () => {
  // The budget's only use is `total > maxPackages`, and that comparison is
  // false for NaN. A bare flag, or one followed by another flag, therefore used
  // to disable the package-count assertion while the log still printed the
  // budget it was no longer applying.
  assert.equal(maxPackagesFrom([]), 925)
  assert.equal(maxPackagesFrom(["--keep-tmp"]), 925)
  assert.equal(maxPackagesFrom(["--max-packages", "1200"]), 1200)
  for (const args of [["--max-packages"], ["--max-packages", "--keep-tmp"], ["--max-packages", ""], ["--max-packages", "0"], ["--max-packages", "-1"], ["--max-packages", "9.5"], ["--max-packages", "1e400"]]) {
    assert.throws(() => maxPackagesFrom(args), /--max-packages requires a positive integer/, args.join(" "))
  }
})

it("exits 2 with usage on a bare --max-packages instead of installing under no budget", () => {
  const result = spawnSync(process.execPath, ["scripts/check-npm-dedupe.mjs", "--max-packages"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /--max-packages requires a positive integer/)
  assert.match(result.stderr, /usage: node scripts\/check-npm-dedupe\.mjs/)
  assert.doesNotMatch(result.stdout, /resolved package count/)
})

it("requires exactly one physical Effect copy at the zero, one, and two-copy boundaries", async () => {
  for (const count of [0, 1, 2]) {
    const root = await mkdtemp(join(tmpdir(), "smithers-k-effect-boundary-"))
    try {
      for (let index = 0; index < count; index++) {
        const directory = index === 0
          ? join(root, "node_modules/effect")
          : join(root, "node_modules/parent/node_modules/effect")
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.115" }))
      }
      const profile = { name: "boundary-" + count, dependencies: { effect: "4.0.0-rc.115" } }
      if (count === 1) assert.equal(assertConsumerTree(root, profile).effectCopies.length, 1)
      else assert.throws(() => assertConsumerTree(root, profile), /expected exactly one physical Effect copy/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it("distinguishes optional library peers from a selected executable's requirements", () => {
  const library = { peerDependencies: { runtime: "1", renderer: "1" },
    peerDependenciesMeta: { runtime: { optional: true }, renderer: { optional: true } } }
  assert.deepEqual(optionalPeersOf([library]), ["renderer", "runtime"])
  assert.deepEqual(optionalPeersOf([library, { dependencies: { runtime: "1" } }]), ["renderer"])
  assert.deepEqual(optionalPeersOf([library, { peerDependencies: { runtime: "1" } }]), ["renderer"])
  assert.deepEqual(optionalPeersOf([library, { name: "runtime" }]), ["renderer"])
})

it("isolates each default library and the CLI on npm and pnpm, and refuses an incompatible Effect RC", { timeout: 10 * 60_000 }, async () => {
  const results = await resolveConsumerProfiles()
  for (const manager of ["npm", "pnpm"]) {
    const profiles = results.filter((result) => result.manager === manager)
    assert.deepEqual(profiles.map((result) => result.profile), [
      "database-default", "gateway-default", "observability-default", "flows-default", "cli-default"
    ])
    for (const profile of profiles) {
      assert.equal(profile.effectCopies.length, 1)
      assert.ok(profile.resolutions.length > 0)
      if (manager === "pnpm") assert.equal(profile.managerVersion, "11.25.0", "consumer must use the release toolchain, including on Node 22")
    }
    assert.equal(results.filter((result) => result.incompatible?.manager === manager).length, 1)
  }
})

describe("check-npm-dedupe", () => {
  let tree

  before(() => {
    tree = resolveConsumerTree()
  }, { timeout: 10 * 60_000 })

  it("resolves every singleton to exactly one copy", () => {
    for (const name of SINGLETONS) {
      const copies = copiesOf(tree.lockPackages, name)
      const versions = [...new Set(copies.map((key) => tree.lockPackages[key]?.version))]
      assert.equal(copies.length, 1, `${name} resolves to ${copies.length} copies:\n  - ${copies.join("\n  - ")}`)
      assert.equal(versions.length, 1, `${name} resolves to ${versions.length} versions: ${versions.join(", ")}`)
    }
  })

  it("keeps peers optional across the selected release set out of the default install", () => {
    const present = tree.optionalPeers
      .map((name) => [name, copiesOf(tree.lockPackages, name)])
      .filter(([, copies]) => copies.length > 0)
    assert.deepEqual(
      present.map(([name]) => name),
      [],
      "an optional peer a release manifest still pulls in through a hard dependency is not optional for a consumer:\n"
        + present.map(([name, copies]) => `  ${name}\n    - ${copies.join("\n    - ")}`).join("\n"),
    )
  })

  it("derives the optional-peer set from the release manifests", () => {
    assert.ok(tree.packages.length > 0, "the release set is empty")
    assert.ok(
      tree.optionalPeers.length > 0,
      "no release manifest declares an optional peer, which would make the cell above vacuous",
    )
  })

  it("allows a workspace optional peer explicitly installed by the consumer fixture", () => {
    assert.equal(tree.optionalPeers.includes("@smthrs/platform-browser"), false)
    assert.equal(copiesOf(tree.lockPackages, "@smthrs/platform-browser").length, 1)
    assert.equal(copiesOf(tree.lockPackages, "@effect/platform-bun").length, 1)
  })
})
