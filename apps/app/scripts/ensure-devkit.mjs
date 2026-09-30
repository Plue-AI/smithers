/*
 * Electrobun 2.x ships no SDK in node_modules: Hutch projects it into
 * .hutch/devkit (gitignored) with `electrobun prepare`. tsconfig.json extends
 * the projected tsconfig and vite.config.ts imports the projected Vite
 * aliases, so a fresh clone or worktree cannot typecheck or build until the
 * projection exists. This script makes that step automatic.
 *
 *   node scripts/ensure-devkit.mjs          exit 1 when the devkit cannot be prepared
 *   node scripts/ensure-devkit.mjs --soft   warn and exit 0 instead (postinstall)
 *
 * Runs as `postinstall` (so `pnpm install` leaves a usable tree) and ahead of
 * every script that reads the projection (typecheck, start, build, the T1
 * web server, the T2 launcher). It is a no-op when the projection matches the
 * installed electrobun version. Plain ESM so node and bun both run it.
 * On a fresh machine the first `prepare` downloads Hutch and the Electrobun
 * release into ~/.hutch, which needs the network. electrobun fetches Hutch with
 * `node:https`, which ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set, so
 * a host whose only egress is a proxy (a Cloud guest) could not prepare.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const UI_DIR = fileURLToPath(new URL("..", import.meta.url))
const DEVKIT = join(UI_DIR, ".hutch", "devkit")
const ELECTROBUN_BIN = join(UI_DIR, "node_modules", "electrobun", "bin", "electrobun.cjs")
const ELECTROBUN_PACKAGE = join(UI_DIR, "node_modules", "electrobun", "package.json")
const soft = process.argv.includes("--soft")

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/** The devkit is usable when the files our configs read exist and its version matches the installed package. */
const devkitIsFresh = () => {
  const needed = ["tsconfig.json", "projection.json", join("api", "config", "electrobun-vite.ts")]
  if (!needed.every((file) => existsSync(join(DEVKIT, file)))) return false
  const installed = readJson(ELECTROBUN_PACKAGE)?.version
  const projected = readJson(join(DEVKIT, "projection.json"))?.product?.version
  return typeof installed === "string" && installed === projected
}

const report = (message) => {
  if (soft) {
    console.warn(`ensure-devkit: ${message} (continuing; run \`pnpm exec electrobun prepare\` in apps/app)`)
    process.exit(0)
  }
  console.error(`ensure-devkit: ${message}`)
  process.exit(1)
}

if (!devkitIsFresh()) {
  if (!existsSync(ELECTROBUN_BIN)) report("node_modules/electrobun is not installed; run pnpm install")
  console.log("ensure-devkit: projecting .hutch/devkit (electrobun prepare)")
  // The shim is a node script (`#!/usr/bin/env node`); keep it on node even when this file runs under bun.
  const node = process.versions.bun === undefined ? process.execPath : "node"
  const result = spawnSync(node, [ELECTROBUN_BIN, "prepare"], {
    cwd: UI_DIR,
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" }
  })
  if (result.error) report(`electrobun prepare failed to start: ${result.error.message}`)
  if (result.status !== 0) report(`electrobun prepare exited ${result.status ?? "by signal"}`)
  if (!devkitIsFresh()) report("electrobun prepare finished but .hutch/devkit is still incomplete")
}
