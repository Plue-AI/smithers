import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { TestProject } from "vitest/node"

/**
 * Rebuilds the source-checkout native helper these suites execute.
 *
 * In a checkout the helper resolves to `target/release` (else `target/debug`),
 * which a source change leaves behind: a stale build then fails tests for
 * behavior its source already has. Cargo decides freshness, so an up-to-date
 * build costs one no-op invocation. Outside a checkout, with no checkout
 * build, or without cargo, resolution is left to report its own install hint.
 */
export default function rebuildNativeHelper({ config }: TestProject): void {
  const checkout = resolve(config.root, "../../../..")
  if (!existsSync(join(checkout, "pnpm-workspace.yaml"))) return
  const profile = ["release", "debug"].find((name) => existsSync(join(checkout, "target", name, "smithers-jj-export")))
  if (profile === undefined) return
  const build = spawnSync(
    "cargo",
    [
      "build",
      "--locked",
      ...(profile === "release" ? ["--release"] : []),
      "-p",
      "smithers-ffi",
      "--bin",
      "smithers-jj-export"
    ],
    { cwd: checkout, stdio: ["ignore", "inherit", "inherit"], timeout: 15 * 60_000 }
  )
  if ((build.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return
  if (build.error !== undefined || build.status !== 0) {
    throw new Error(`Rebuilding the ${profile} smithers-jj-export helper failed`, { cause: build.error })
  }
}
