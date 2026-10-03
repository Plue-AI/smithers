import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { retargetSource, versionedSources } from "../set-release-version.mjs"

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const version = process.env.RELEASE_TAG?.replace(/^v/, "") ?? JSON.parse(read("packages/smithers/package.json")).version

test("operator image tag and packaged distribution match the release", () => {
  const tags = [...read("distribution/README.md").matchAll(/ghcr\.io\/smithersai\/smithers:([^\s"'`]+)/g)].map((match) => match[1])
  assert.ok(tags.length > 0, "the install guide must identify the image")
  assert.deepEqual([...new Set(tags)], [version])
  assert.ok(read("distribution/Dockerfile").includes(`ARG SMITHERS_DISTRIBUTION_VERSION=${version}\n`))
})

test("the version bump updates all distribution version declarations", () => {
  for (const path of ["distribution/README.md", "distribution/Dockerfile"]) {
    const source = versionedSources.find((entry) => entry.path === path)
    assert.ok(source, `${path} must participate in release version bumps`)
    const changed = retargetSource(read(path), "9.8.7-next.1", source)
    assert.ok(changed.includes("9.8.7-next.1"))
    assert.equal(source.pattern.exec(changed)?.[2], "9.8.7-next.1", `${path} retains the old version`)
  }
})
