/**
 * The runtime class of every published subpath, proved by bundling it.
 *
 * A scaffolded app splits this package across three hosts. `routes.ui.gen.ts`
 * pulls `./app` and `./ui` into the browser bundle; the aomi template's
 * Cloudflare Worker imports `./runtime` at value level and the default
 * template's imports `./worker`; `./router`, `./vite`,
 * `./package`, and `./testing` are Node-only build and test tooling. Nothing
 * held that split: `scripts/browser-check.mjs` enumerates the repository's
 * frozen browser contract and this package is in neither its BROWSER_SAFE nor
 * its NODE_ONLY inventory, so a `node:` builtin arriving through
 * `@smthrs/engine` or `@smthrs/agent` would break scaffolded Workers with no
 * gate firing.
 *
 * Each assertion names the builtin it expects rather than only asserting that
 * a build failed, so an entry point that starts failing for a NEW reason is a
 * test failure rather than a silent pass.
 */
import { describe, expect, it } from "@effect/vitest"
import * as esbuild from "esbuild"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

/**
 * The peers a host supplies. They are not part of the runtime question: an app
 * that imports `./ui` has React, and one that imports `./vite` has Vite.
 */
const external = ["react", "react-dom", "react/jsx-runtime", "vite", "vitest", "tsx", "tsx/*"]

/** The `node:` builtins one entry point could not resolve, deduplicated. */
const unresolvedBuiltins = async (entry: string): Promise<ReadonlyArray<string>> => {
  try {
    await esbuild.build({
      absWorkingDir: packageRoot,
      entryPoints: [`src/${entry}.ts`],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
      external
    })
    return []
  } catch (cause) {
    const errors = (cause as { readonly errors?: ReadonlyArray<{ readonly text: string }> }).errors ?? []
    if (errors.length === 0) throw cause
    const named = errors.flatMap((error) => {
      const match = /Could not resolve "(node:[a-z/]+)"/.exec(error.text)
      return match === null ? [] : [match[1]!]
    })
    // A failure that names no builtin is not a runtime-class failure, and
    // reporting it as one would hide a real bundling defect.
    if (named.length === 0) {
      throw new Error(`${entry} failed for a reason other than a node builtin: ${errors[0]!.text}`)
    }
    return [...new Set(named)].sort()
  }
}

describe("browser and workerd entry points", () => {
  it.each(["app", "ui", "runtime", "worker", "http"])(
    "bundles @smthrs/create-app/%s with no node builtin",
    async (entry) => {
      expect(await unresolvedBuiltins(entry)).toEqual([])
    }
  )
})

describe("Node-only entry points", () => {
  const documented: ReadonlyArray<readonly [string, string]> = [
    ["router", "node:fs"],
    ["vite", "node:fs"],
    ["package", "node:crypto"],
    ["testing", "node:fs"],
    ["routesBin", "node:fs"],
    ["index", "node:crypto"]
  ]

  it.each(documented)("refuses to bundle @smthrs/create-app/%s, naming %s", async (entry, builtin) => {
    expect(await unresolvedBuiltins(entry)).toContain(builtin)
  })
})
