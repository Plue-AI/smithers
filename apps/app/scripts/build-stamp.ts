import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

/*
 * CN-1: the build stamp. The built SPA is the artifact that goes stale, so it
 * must be able to state which commit it was built from. The stamp is written
 * by the build and travels inside the bundle: a meta tag on the served HTML
 * and a `__build.json` asset next to the hashed chunks.
 *
 * apps/server/scripts/canary/build-probe.ts reads both, so the asset name, the
 * meta name, and the JSON shape are a contract; BuildStamp.test.ts there pins
 * them against this file. The plugin lives here rather than in vite.config.ts
 * so a host that is not this package's Vite build (the smithers.sh Astro site
 * mounting the app as an island) can stamp the same way.
 *
 * SMITHERS_BUILD_SHA wins so a release script stamps the sha it records;
 * GITHUB_SHA covers a CI build; otherwise the local checkout is asked. A tree
 * with no supported checkout answers "unknown".
 */
export const BUILD_STAMP_ASSET = "__build.json"
export const BUILD_STAMP_META = "smithers-build-sha"
export const BUILD_STAMP_AT_META = "smithers-build-at"

/** The apps/app package root, inside either a jj workspace or a Git checkout. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

export const resolveBuildSha = (): string => {
  const fromEnv = process.env.SMITHERS_BUILD_SHA ?? process.env.GITHUB_SHA
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim()
  try {
    if (existsSync(resolve(packageRoot, "../..", ".jj"))) {
      const diff = execFileSync("jj", ["diff", "--summary"], { cwd: packageRoot, encoding: "utf8" }).trim()
      return execFileSync("jj", ["--ignore-working-copy", "log", "-r", diff === "" ? "@-" : "@", "--no-graph", "-T", "commit_id"], { cwd: packageRoot, encoding: "utf8" }).trim()
    }
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

export interface BuildStampValues {
  readonly gitSha: string
  readonly builtAt: string
}

/** The two values one build stamps everywhere, resolved once so HTML and asset agree. */
export const buildStampValues = (): BuildStampValues => {
  const epoch = process.env.SOURCE_DATE_EPOCH
  const at = epoch === undefined ? Date.now() : Number(epoch) * 1000
  if (epoch !== undefined && (!/^\d+$/.test(epoch) || !Number.isSafeInteger(at) || at > 8.64e15)) throw new Error("Invalid SOURCE_DATE_EPOCH")
  return { gitSha: resolveBuildSha(), builtAt: new Date(at).toISOString() }
}

/** The `<meta>` tags the served HTML carries; the probe reads the first by name. */
export const buildStampMetaTags = ({ gitSha, builtAt }: BuildStampValues): ReadonlyArray<{ readonly name: string; readonly content: string }> => [
  { name: BUILD_STAMP_META, content: gitSha },
  { name: BUILD_STAMP_AT_META, content: builtAt }
]

/** The `__build.json` body, byte for byte what the Vite build emits. */
export const buildStampAssetSource = ({ gitSha, builtAt }: BuildStampValues): string =>
  `${JSON.stringify({ app: "smithers-app", gitSha, builtAt }, null, "\t")}\n`

export const buildStamp = (): Plugin => {
  const values = buildStampValues()
  return {
    name: "smithers-build-stamp",
    apply: "build",
    transformIndexHtml: () =>
      buildStampMetaTags(values).map((attrs) => ({ tag: "meta", attrs, injectTo: "head" as const })),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: BUILD_STAMP_ASSET, source: buildStampAssetSource(values) })
    }
  }
}
