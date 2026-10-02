import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { satisfies } from "semver"
import { readWorkspaceManifests } from "./pack-release.mjs"

/** The one Node range every published package declares: `node:ffi` first ships in 26.4. */
const supported = ">=26.4.0"

test("every published package declares the supported Node range", () => {
  const manifests = readWorkspaceManifests()
  assert.ok([...manifests.values()].some((manifest) => manifest.name === "@smthrs/cli"))
  for (const manifest of manifests.values()) assert.equal(manifest.engines.node, supported, manifest.name)
})

test("the cell compiler's parser accepts the supported Node floor", () => {
  const harnessRequire = createRequire(new URL("../packages/smithers/agent/harness/package.json", import.meta.url))
  for (const dependency of ["@babel/parser", "@babel/types"]) {
    const range = harnessRequire(`${dependency}/package.json`).engines.node
    assert.ok(satisfies("26.4.0", range), `${dependency} requires node ${range}; recheck the public support range`)
  }
})
