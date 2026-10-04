import { afterEach, expect, test } from "bun:test"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { writeBundleManifest, verifyBundleManifest } from "./server-bundle-manifest"
const roots: string[] = []
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-manifest-")); roots.push(root)
  mkdirSync(join(root, "bin"))
  writeFileSync(join(root, "bin/server"), "literal executable bytes", { mode: 0o755 })
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test("independent SHA and mode survive relocation, including internal symlinks", () => {
  const root = fixture(); symlinkSync("server", join(root, "bin/alias"))
  writeBundleManifest(root, "a".repeat(40))
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
  expect(manifest.files.find((entry: { path: string }) => entry.path === "bin/server")).toEqual({ path: "bin/server", sha256: createHash("sha256").update("literal executable bytes").digest("hex"), stage: "host", mode: 0o755 })
  const relocated = fixture(); cpSync(root, relocated, { recursive: true, verbatimSymlinks: true }); rmSync(root, { recursive: true })
  expect(() => verifyBundleManifest(relocated)).not.toThrow()
})
for (const change of ["unlisted", "changed", "removed", "mode", "link", "version", "revision", "platform"] as const) {
  test(`refuses ${change}`, () => {
    const root = fixture(); symlinkSync("server", join(root, "bin/alias")); writeBundleManifest(root, "b".repeat(40))
    if (change === "unlisted") writeFileSync(join(root, "extra"), "extra")
    else if (change === "changed") writeFileSync(join(root, "bin/server"), "different")
    else if (change === "removed") rmSync(join(root, "bin/alias"))
    else if (change === "mode") chmodSync(join(root, "bin/server"), 0o644)
    else if (change === "link") { rmSync(join(root, "bin/alias")); symlinkSync("/etc/hosts", join(root, "bin/alias")) }
    else { const path = join(root, "manifest.json"); const manifest = JSON.parse(readFileSync(path, "utf8")); manifest[change] = "invalid"; writeFileSync(path, JSON.stringify(manifest)) }
    expect(() => verifyBundleManifest(root)).toThrow()
  })
}
test("refuses an escaping symlink before manifest publication", () => {
  const root = fixture(); symlinkSync("/etc/hosts", join(root, "bin/outside"))
  expect(() => writeBundleManifest(root, "c".repeat(40))).toThrow("escapes")
})

test("manifest uses the landed host-start verifier contract", async () => {
  const { verifyBundle } = await import("../../../packages/smithers/src/internal/backend/HostService")
  const root = fixture()
  for (const name of ["smithers-server", "smithers-backend", "msb"]) writeFileSync(join(root, "bin", name), "literal host-start executable", { mode: 0o755 })
  symlinkSync("server", join(root, "bin/alias"))
  writeBundleManifest(root, "d".repeat(40))
  expect(() => verifyBundle(root)).not.toThrow()
})
