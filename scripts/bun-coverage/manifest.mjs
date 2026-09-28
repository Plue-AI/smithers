import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { digest, instrument, mapDigest, options, versions } from "./instrument.mjs"

function ownerPath(root, path) {
  assert.ok(typeof path === "string" && !isAbsolute(path), "Source paths must be relative to the owning root")
  const absolute = resolve(root, path)
  const canonical = relative(root, absolute).split(sep).join("/")
  assert.ok(!canonical.startsWith("../") && canonical !== ".." && path === canonical, "Noncanonical owning source path")
  assert.match(path, /\.(?:[cm]?[jt]sx?)$/, "Owning source must be JavaScript or TypeScript")
  assert.equal(realpathSync(absolute), absolute, "Declare the canonical source, not a symlink alias")
  return absolute
}

export function prepare(root, roster) {
  root = realpathSync(root)
  assert.ok(Array.isArray(roster) && roster.length > 0, "An explicit owning source roster is required")
  const paths = [...roster].sort()
  assert.equal(new Set(paths).size, paths.length, "Duplicate owning source")
  const zero = {}
  const codes = new Map()
  const sources = paths.map((path) => {
    const absolute = ownerPath(root, path)
    const source = readFileSync(absolute, "utf8")
    const compiled = instrument(source, path)
    zero[path] = compiled.zero
    codes.set(absolute, compiled)
    return { path, sha256: digest(source), mapDigest: compiled.mapDigest, typeOnly: path.endsWith(".d.ts") }
  })
  const artifacts = Object.fromEntries(sources.map(({ path }) => {
    const { code, loader } = codes.get(resolve(root, path))
    return [path, { code, loader, zero: zero[path] }]
  }))
  const identity = { schema: 1, sources, pipeline: { options, versions }, artifactDigest: digest(artifacts) }
  return { manifest: { ...identity, root, digest: digest(identity) }, zero, codes, artifacts }
}

export function verifyManifest(manifest) {
  assert.equal(manifest?.schema, 1, "Unsupported coverage manifest")
  const prepared = prepare(manifest.root, manifest.sources.map((source) => source.path))
  assert.deepEqual(prepared.manifest, manifest, "Coverage source, version, options or map changed")
  return prepared
}

/** Validate the root compiler's sealed artifact without recompiling in a child. */
export function verifyArtifacts(manifest, artifacts) {
  assert.equal(manifest?.schema, 1, "Unsupported coverage manifest")
  assert.equal(realpathSync(manifest.root), manifest.root, "Owning root changed")
  const { root, digest: identityDigest, ...identity } = manifest
  assert.equal(digest(identity), identityDigest, "Coverage manifest identity changed")
  assert.deepEqual(manifest.pipeline, { options, versions }, "Coverage version or options changed")
  assert.ok(Array.isArray(manifest.sources) && manifest.sources.length > 0, "Missing owning source roster")
  const paths = manifest.sources.map((source) => source.path)
  assert.deepEqual(paths, [...new Set(paths)].sort(), "Duplicate or unordered owning source")
  assert.ok(artifacts && typeof artifacts === "object" && !Array.isArray(artifacts), "Invalid instrumentation artifacts")
  assert.deepEqual(Object.keys(artifacts).sort(), paths, "Instrumentation artifact roster changed")
  assert.equal(digest(artifacts), manifest.artifactDigest, "Instrumentation artifact digest changed")
  const zero = {}, codes = new Map()
  for (const source of manifest.sources) {
    const absolute = ownerPath(root, source.path)
    assert.equal(digest(readFileSync(absolute, "utf8")), source.sha256, "Coverage source changed")
    const artifact = artifacts[source.path]
    assert.deepEqual(Object.keys(artifact).sort(), ["code", "loader", "zero"], "Instrumentation artifact shape changed")
    assert.equal(typeof artifact.code, "string", "Instrumentation code is missing")
    assert.equal(artifact.loader, /\.(?:tsx|jsx)$/.test(source.path) ? "jsx" : "js", "Instrumentation loader changed")
    assert.equal(artifact.zero.path, source.path, "Instrumentation source path changed")
    assert.equal(mapDigest(artifact.zero), source.mapDigest, "Instrumentation map changed")
    for (const kind of ["s", "f", "b"]) {
      const values = Object.values(artifact.zero[kind])
      assert.ok((kind === "b" ? values.flat() : values).every((hit) => hit === 0), "Instrumentation seed has hits")
      const maps = artifact.zero[{ s: "statementMap", f: "fnMap", b: "branchMap" }[kind]]
      assert.deepEqual(Object.keys(artifact.zero[kind]).sort(), Object.keys(maps).sort(), "Instrumentation seed shape changed")
      if (kind === "b") for (const [key, hits] of Object.entries(artifact.zero.b)) {
        assert.ok(Array.isArray(hits) && hits.length === artifact.zero.branchMap[key].locations.length, "Instrumentation branch seed shape changed")
      }
    }
    zero[source.path] = structuredClone(artifact.zero)
    codes.set(absolute, artifact)
  }
  return { manifest, artifacts, zero, codes }
}
