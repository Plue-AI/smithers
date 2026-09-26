/** Pins the offline CI registration and its separate operator prerequisites. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Package as RootPackage } from "../../../PACKAGE.ts"
import { metadata } from "../../../packages/smithers/build/targets/src/Target.ts"
import { Package } from "../PACKAGE.ts"

const root = resolve(import.meta.dirname, "../../..")
assert.ok(Package.offline, "SWE-bench declares an offline test target")
const offline = metadata(Package.offline)
assert.equal(offline.target, "Shell.Test")
assert.deepEqual(offline.kinds, ["test"])
assert.equal(offline.attrs.script.path, "verify.sh")
assert.deepEqual(offline.attrs.args, ["--offline"])
for (
  const pattern of ["//evals/swebench/*.{ts,mjs,sh,md}", "//evals/swebench/lib/**", "//evals/swebench/fixtures/**"]
) {
  assert.ok(offline.attrs.data.some((input) => input.pattern === pattern), `offline inputs include ${pattern}`)
}
const prerequisites = metadata(Package.prerequisites)
assert.equal(prerequisites.target, "Shell.Run")
assert.deepEqual(prerequisites.kinds, ["run"])
assert.deepEqual(prerequisites.attrs.args, ["--prerequisites"])
const jobs = metadata(RootPackage.ci).attrs.jobs
const job = jobs.find((job) => job.steps.some((step) => step.pattern === "//evals/swebench:offline"))
assert.ok(job, "the CI declaration selects the offline fixtures")
assert.ok(!job.continueOnError, "the offline CI job is required")
const step = job.steps.find((step) => step.pattern === "//evals/swebench:offline")
assert.equal(step.verb.name, "test")
assert.equal(step.parallelism, 1)
const verification = readFileSync(resolve(root, "evals/swebench/verify.sh"), "utf8")
const operator = verification.slice(verification.indexOf("  --prerequisites)"), verification.indexOf("esac"))
const suite = verification.slice(verification.indexOf("esac") + 4)
for (const fixture of ["check-subject.mjs", "check-eval-exports.py", "check-prompt-bytes.mjs"]) {
  assert.ok(operator.includes(fixture), `${fixture} requires explicit operator prerequisites`)
  assert.ok(!suite.includes(fixture), `${fixture} is outside the offline suite`)
}
for (
  const fixture of [
    "check-fullbench.mjs",
    "check-prompts.mjs",
    "check-run-paths.mjs",
    "check-lock.sh",
    "check-compare-codex-lanes.mjs",
    "check-cli-path.mjs"
  ]
) {
  assert.ok(suite.includes(fixture), `the offline suite runs ${fixture}`)
}
const temporary = mkdtempSync(join(tmpdir(), "swebench-prerequisites-"))
try {
  const rig = join(temporary, "evals/swebench")
  mkdirSync(rig, { recursive: true })
  const script = join(rig, "verify.sh")
  writeFileSync(script, verification)
  const run = (arg) => spawnSync("bash", [script, arg], { encoding: "utf8", timeout: 10_000 })
  const unbuilt = run("--prerequisites")
  assert.equal(unbuilt.status, 1, unbuilt.stderr)
  assert.match(unbuilt.stderr, /build the CLI with \.\/preflight\.sh first/)
  const dist = join(temporary, "packages/smithers/dist/esm")
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, "bin.js"), "")
  const noVenv = run("--prerequisites")
  assert.equal(noVenv.status, 1, noVenv.stderr)
  assert.match(noVenv.stderr, /bootstrap\.sh to provision the evaluator venv/)
  assert.equal(run("--unknown").status, 2, "unknown verification modes are rejected")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")
assert.ok(
  ci.includes("smthrs test '//evals/swebench:offline' --jobs 1"),
  "required CI must run the serial offline SWE-bench target"
)
assert.ok(!ci.includes("//evals/swebench:prerequisites"), "operator prerequisites stay outside CI")
console.log("check-offline-target.mjs: offline fixtures gate CI; operator prerequisites are explicit.")
