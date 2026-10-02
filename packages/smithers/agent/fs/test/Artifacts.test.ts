import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
// scripts/build.mjs imports the shared helper by a path relative to the
// package, so the scratch mirrors both at their repository locations. The
// helper is a declared input of the package build target (RELEASE_SUPPORT.md).
const packagePath = relative(repoRoot, packageRoot)
const buildHelperPaths = [
  "packages/repo-targets/scripts/build-library.mjs",
  "packages/repo-targets/scripts/private-effect-adapters.mjs"
]

interface Scratch {
  /** The mirrored repository root; remove this to discard the fixture. */
  readonly root: string
  /** The package copy inside `root`, where the build and the fixtures run. */
  readonly packageDir: string
}

const linkDependencies = (source: string, target: string): void => {
  const link = (name: string): void => {
    const installed = realpathSync(join(source, name))
    const destination = join(target, name)
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(installed, destination, statSync(installed).isDirectory() ? "junction" : "file")
  }
  for (const name of readdirSync(source)) {
    if (name.startsWith("@")) {
      for (const member of readdirSync(join(source, name))) link(join(name, member))
    } else {
      link(name)
    }
  }
}

const copyPackage = (source: string): Scratch => {
  const root = mkdtempSync(join(tmpdir(), "smithers-fs-artifacts-"))
  const packageDir = join(root, packagePath)
  try {
    for (const path of ["src", "scripts", "test/fixtures", "tsconfig.json", "package.json"]) {
      cpSync(join(source, path), join(packageDir, path), { recursive: true })
    }
    for (const path of buildHelperPaths) cpSync(join(repoRoot, path), join(root, path))
    // Resolve each package before linking it: a junction over node_modules
    // leaves pnpm's relative workspace links dependent on the scratch path.
    // Include hoisted build tools from the repository root.
    linkDependencies(join(repoRoot, "node_modules"), join(root, "node_modules"))
    linkDependencies(join(packageRoot, "node_modules"), join(packageDir, "node_modules"))
    return { root, packageDir }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

const smokeArtifacts = (source: string): void => {
  // build.mjs owns dist relative to its own location. Copy its inputs so
  // neither the build nor the fixture imports touch another process's output.
  const scratch = copyPackage(source)
  try {
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: scratch.packageDir,
      timeout: 120_000,
      stdio: "inherit"
    })
    execFileSync(process.execPath, ["test/fixtures/artifact-esm.mjs"], { cwd: scratch.packageDir, timeout: 20_000 })
    execFileSync(process.execPath, ["test/fixtures/artifact-cjs.cjs"], { cwd: scratch.packageDir, timeout: 20_000 })
  } finally {
    rmSync(scratch.root, { recursive: true, force: true })
  }
}

describe("built artifacts", () => {
  it(
    "imports every documented ESM and CJS subpath with one root identity",
    () => {
      smokeArtifacts(packageRoot)
    },
    180_000
  )

  it("preserves output owned by another build", () => {
    // Use a private package fixture so this assertion cannot race a real build.
    const source = copyPackage(packageRoot)
    const sentinel = join(source.packageDir, "dist", "another-build.txt")
    try {
      mkdirSync(join(source.packageDir, "dist"))
      writeFileSync(sentinel, "owned by another build")
      smokeArtifacts(source.packageDir)
      expect(readFileSync(sentinel, "utf8")).toBe("owned by another build")
    } finally {
      rmSync(source.root, { recursive: true, force: true })
    }
  }, 180_000)
})
