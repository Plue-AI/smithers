import test from "node:test"
import assert from "node:assert/strict"

import { EXPECTED_EFFECT_VERSION, assertNodeSharedPins, nodeSharedPinProblems } from "./check-single-effect-version.mjs"
import { readWorkspaceManifests } from "./pack-release.mjs"
import { repoRoot } from "./workspace-packages.mjs"

const pin = EXPECTED_EFFECT_VERSION
const manifests = (entries) => new Map(entries.map((manifest, index) => [`packages/fixture-${index}`, { name: `@fixture/${index}`, ...manifest }]))

// npm, pnpm and Bun each resolved @effect/platform-node-shared@4.0.0-rc.118
// under a package shaped like the rejected fixtures (#2398).
test("rejects a platform dependency without an exact node-shared dependency", () => {
  for (const platform of ["@effect/platform-bun", "@effect/platform-node"]) {
    for (const manifest of [
      { dependencies: { [platform]: pin, effect: pin } },
      { dependencies: { [platform]: pin, effect: pin }, peerDependencies: { "@effect/platform-node-shared": pin } },
      { dependencies: { [platform]: pin, effect: pin }, devDependencies: { "@effect/platform-node-shared": pin } },
      { dependencies: { [platform]: pin, "@effect/platform-node-shared": `^${pin}` } },
      { optionalDependencies: { [platform]: pin } }
    ]) {
      const problems = nodeSharedPinProblems(manifests([manifest]))
      assert.equal(problems.length, 1, JSON.stringify(manifest))
      assert.match(problems[0], new RegExp(`${platform.replace("/", "\\/")} without an exact @effect/platform-node-shared@${pin.replaceAll(".", "\\.")} in dependencies$`))
      assert.throws(() => assertNodeSharedPins(manifests([manifest])), /leave @effect\/platform-node-shared to a caret range/)
    }
  }
})

test("rejects a platform peer without node-shared among its dependencies or peers", () => {
  const problems = nodeSharedPinProblems(manifests([
    { peerDependencies: { "@effect/platform-bun": pin, "@effect/platform-node": pin, effect: pin } }
  ]))
  assert.deepEqual(problems, [
    `packages/fixture-0 (@fixture/0): peerDependencies declares @effect/platform-bun and @effect/platform-node without an exact @effect/platform-node-shared@${pin} in dependencies or peerDependencies`
  ])
})

test("accepts the pinned shapes and packages without a platform", () => {
  const accepted = manifests([
    { dependencies: { "@effect/platform-node": pin, "@effect/platform-node-shared": pin, effect: pin } },
    { dependencies: { "@effect/platform-bun": pin, "@effect/platform-node": pin, "@effect/platform-node-shared": pin } },
    { peerDependencies: { "@effect/platform-node": pin, "@effect/platform-node-shared": pin, effect: pin } },
    { peerDependencies: { "@effect/platform-bun": pin }, dependencies: { "@effect/platform-node-shared": pin } },
    { dependencies: { effect: pin }, devDependencies: { "@effect/platform-node": pin } },
    {}
  ])
  assert.deepEqual(nodeSharedPinProblems(accepted), [])
  assert.doesNotThrow(() => assertNodeSharedPins(accepted))
})

test("every published workspace package pins node-shared where it declares a platform", () => {
  const published = readWorkspaceManifests(repoRoot)
  assert.ok(published.size > 0)
  assert.deepEqual(nodeSharedPinProblems(published), [])
  const cli = [...published.values()].find((manifest) => manifest.name === "@smthrs/cli")
  assert.equal(cli.dependencies["@effect/platform-node-shared"], pin)
})
