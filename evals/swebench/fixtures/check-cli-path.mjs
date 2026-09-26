/**
 * Asserts `flows.sh` execs the CLI this repository ships.
 *
 *   node fixtures/check-cli-path.mjs
 *
 * The rig arrived from a checkout whose CLI was entered at
 * `packages/smithers/dist/esm/bin.js` directly. Here the shipped executable is
 * `packages/smithers/bin/smithers.mjs`, the file `@smthrs/cli` declares as its bin,
 * and it prefers that build but falls back to `src/bin.ts` when there is none.
 *
 * Both halves are checked, because each one alone is a trap:
 *
 *   - Exec the shim, and a wave run without a build silently measures source
 *     that no fingerprint covers. So the wrapper must refuse when the build is
 *     absent.
 *   - Exec the build directly, and the rig runs a file the product does not
 *     ship, which is how the path went stale in the first place.
 *
 * The refusal is checked by running the wrapper against a copy of the rig
 * rooted at a tree with no `dist`, so nothing has to be deleted from the real
 * checkout to prove it.
 *
 * Offline, spends nothing, needs no docker.
 *
 * @since 1.0.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const here = import.meta.dirname
const rig = resolve(here, "..")
const root = resolve(rig, "../..")
const wrapper = readFileSync(join(rig, "flows.sh"), "utf8")

const cliPackage = "packages/smithers"
const manifest = JSON.parse(readFileSync(join(root, cliPackage, "package.json"), "utf8"))
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.smithers
assert.equal(typeof bin, "string", "the CLI package declares its smithers executable")
const executable = join(cliPackage, bin)
assert.ok(existsSync(join(root, executable)), "the declared executable is in the tree")

// The refusal, against a tree shaped like a source checkout with no build.
const temporary = mkdtempSync(join(tmpdir(), "swebench-cli-path-"))
try {
  mkdirSync(dirname(join(temporary, executable)), { recursive: true })
  mkdirSync(join(temporary, "evals/swebench"), { recursive: true })
  writeFileSync(join(temporary, executable), "process.exit(0)\n")
  writeFileSync(join(temporary, "evals/swebench/flows.sh"), wrapper, { mode: 0o755 })

  const unbuilt = spawnSync("bash", [join(temporary, "evals/swebench/flows.sh"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, SWB_SUBJECT_UNPINNED: "1" }
  })
  assert.equal(unbuilt.status, 1, "a checkout with no CLI build is refused, not run against source")
  assert.match(unbuilt.stderr, /would fall back to src\/bin\.ts/)

  writeFileSync(
    join(temporary, executable),
    `
console.log(JSON.stringify({ executable: process.argv[1], args: process.argv.slice(2), cwd: process.cwd() }))
`
  )
  mkdirSync(join(temporary, "packages/smithers/dist/esm"), { recursive: true })
  writeFileSync(join(temporary, "packages/smithers/dist/esm/bin.js"), "\n")
  const built = spawnSync("bash", [join(temporary, "evals/swebench/flows.sh"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, SWB_SUBJECT_UNPINNED: "1" }
  })
  assert.equal(built.status, 0, built.stderr)
  assert.deepEqual(JSON.parse(built.stdout), {
    executable: join(temporary, executable),
    args: ["--help"],
    cwd: process.cwd()
  }, "the wrapper executes the declared bin with the caller's arguments and working directory")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-cli-path.mjs: flows.sh execs the shipped CLI, and refuses a checkout with no build.")
