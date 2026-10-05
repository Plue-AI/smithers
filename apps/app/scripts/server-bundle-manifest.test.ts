import { afterEach, expect, test } from "bun:test"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { codeSignatureFlags, signHardenedBackend, writeBundleManifest, verifyBundleManifest } from "./server-bundle-manifest"
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

// Spec §17.3 (a): the assembler signs the backend ad hoc with the hardened
// runtime, so the dynamic loader ignores DYLD_* variables, with the one
// entitlement that lets it load the bundle's own engine library and not the
// one that would let DYLD_* variables back in; the manifest records the
// signature, and a backend re-signed without the runtime no longer matches.
test.skipIf(process.platform !== "darwin")("signs the backend with the hardened runtime and records it", () => {
  const root = fixture()
  const source = join(root, "main.c")
  writeFileSync(source, "int main(void) { return 0; }\n")
  const backend = join(root, "bin", "smithers-backend")
  expect(Bun.spawnSync(["/usr/bin/cc", "-o", backend, source]).exitCode).toBe(0)
  rmSync(source)
  signHardenedBackend(backend)
  expect(codeSignatureFlags(backend)).toBe("adhoc,runtime")
  const entitlements = new TextDecoder().decode(Bun.spawnSync(["/usr/bin/codesign", "-d", "--entitlements", ":-", backend]).stdout)
  expect(entitlements).toContain("com.apple.security.cs.disable-library-validation")
  expect(entitlements).not.toContain("allow-dyld-environment-variables")
  writeBundleManifest(root, "e".repeat(40))
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
  expect(manifest.files.find((entry: { path: string }) => entry.path === "bin/smithers-backend").codeSignature).toBe("adhoc,runtime")
  expect(() => verifyBundleManifest(root)).not.toThrow()
  expect(Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", backend]).exitCode).toBe(0)
  expect(codeSignatureFlags(backend)).toBe("adhoc")
  expect(() => verifyBundleManifest(root)).toThrow("Bundle manifest mismatch: bin/smithers-backend")
})

test("records the cross-built Linux guest helper and its digest sidecar as the guest-helper stage", () => {
  const root = fixture()
  mkdirSync(join(root, "bin/linux-arm64"))
  writeFileSync(join(root, "bin/linux-arm64/smithers-jj-export"), "linux helper bytes", { mode: 0o755 })
  writeFileSync(join(root, "bin/linux-arm64/smithers-jj-export.sha256"), "digest  smithers-jj-export\n", { mode: 0o644 })
  writeFileSync(join(root, "bin/smithers-jj-export"), "darwin helper bytes", { mode: 0o755 })
  writeBundleManifest(root, "f".repeat(40))
  const stages = Object.fromEntries(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).files.map((entry: { path: string; stage: string }) => [entry.path, entry.stage]))
  expect(stages["bin/linux-arm64/smithers-jj-export"]).toBe("guest-helper")
  expect(stages["bin/linux-arm64/smithers-jj-export.sha256"]).toBe("guest-helper")
  expect(stages["bin/smithers-jj-export"]).toBe("jj")
})
