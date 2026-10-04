import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveBundle, normalizeImageArchive } from "./server-bundle-archive"
import { writeBundleManifest, verifyBundleManifest } from "./server-bundle-manifest"

test("archive survives unpacking and ignores build mtimes", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-archive-"))
  try {
    const bundle = join(root, "bundle")
    mkdirSync(join(bundle, "bin"), { recursive: true })
    writeFileSync(join(bundle, "README.md"), "./bin/smthrs host start --bundle .\n")
    writeFileSync(join(bundle, "bin/smthrs"), "executable\n")
    chmodSync(join(bundle, "bin/smthrs"), 0o755)
    symlinkSync("smthrs", join(bundle, "bin/alias"))
    writeBundleManifest(bundle, "a".repeat(40))
    const image = join(root, "image.tar"), laterImage = join(root, "later-image.tar")
    expect(Bun.spawnSync(["/usr/bin/tar", "-cf", image, "-C", bundle, "."]).exitCode).toBe(0)
    utimesSync(join(bundle, "bin/smthrs"), 22222, 33333)
    expect(Bun.spawnSync(["/usr/bin/tar", "-cf", laterImage, "-C", bundle, "."]).exitCode).toBe(0)
    normalizeImageArchive(image)
    normalizeImageArchive(laterImage)
    expect(readFileSync(image)).toEqual(readFileSync(laterImage))
    const first = archiveBundle(bundle, join(root, "first"))
    utimesSync(join(bundle, "bin/smthrs"), 12345, 54321)
    const second = archiveBundle(bundle, join(root, "second"))
    expect(readFileSync(first)).toEqual(readFileSync(second))
    const unpacked = join(root, "unpacked")
    mkdirSync(unpacked)
    expect(Bun.spawnSync(["/usr/bin/tar", "-xzf", first, "-C", unpacked]).exitCode).toBe(0)
    verifyBundleManifest(unpacked)
    expect(readFileSync(join(unpacked, "bin/alias"), "utf8")).toBe("executable\n")
    const manifest = JSON.parse(readFileSync(join(root, "first/manifest.json"), "utf8"))
    for (const entry of manifest.files) expect(entry.sha256).toBe(createHash("sha256").update(readFileSync(join(root, "first", entry.path))).digest("hex"))
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["smithers-server.tar.gz", "README.md"])
    writeFileSync(join(bundle, "README.md"), "tampered")
    expect(() => archiveBundle(bundle, join(root, "invalid"))).toThrow("manifest mismatch")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
