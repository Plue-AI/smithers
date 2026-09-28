import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { digest, instrument, options, versions } from "./instrument.mjs"

export function prepare(root, roster) {
  root = realpathSync(root)
  assert.ok(Array.isArray(roster) && roster.length > 0, "An explicit owning source roster is required")
  const paths = [...roster].sort()
  assert.equal(new Set(paths).size, paths.length, "Duplicate owning source")
  const zero = {}
  const codes = new Map()
  const sources = paths.map((path) => {
    assert.ok(typeof path === "string" && !isAbsolute(path), "Source paths must be relative to the owning root")
    const absolute = resolve(root, path)
    const canonical = relative(root, absolute).split(sep).join("/")
    assert.ok(!canonical.startsWith("../") && canonical !== ".." && path === canonical, "Noncanonical owning source path")
    assert.match(path, /\.(?:[cm]?[jt]sx?)$/, "Owning source must be JavaScript or TypeScript")
    assert.equal(realpathSync(absolute), absolute, "Declare the canonical source, not a symlink alias")
    const source = readFileSync(absolute, "utf8")
    const compiled = instrument(source, path)
    zero[path] = compiled.zero
    codes.set(absolute, compiled)
    return { path, sha256: digest(source), mapDigest: compiled.mapDigest, typeOnly: path.endsWith(".d.ts") }
  })
  const identity = { schema: 1, sources, pipeline: { options, versions } }
  return { manifest: { ...identity, root, digest: digest(identity) }, zero, codes }
}

export function verifyManifest(manifest) {
  assert.equal(manifest?.schema, 1, "Unsupported coverage manifest")
  const prepared = prepare(manifest.root, manifest.sources.map((source) => source.path))
  assert.deepEqual(prepared.manifest, manifest, "Coverage source, version, options or map changed")
  return prepared
}
