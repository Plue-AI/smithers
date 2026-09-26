/**
 * Asserts the subject fingerprint states facts rather than assumptions.
 *
 *   node fixtures/check-subject.mjs
 *
 * Three things are pinned here, all offline and all free.
 *
 * The first is the module-resolution fact the whole design rests on: the built
 * CLI loads every `@smthrs/*` dependency from its `src` directory, because that
 * is where the workspace `exports` map points, and only `@smthrs/cli` itself is
 * loaded from a build. If someone gives a package a `dist`-shaped `exports` map
 * without building it in the preflight, this fails.
 *
 * The second is that the pin is enforced: `--expect` accepts a matching stamp
 * and rejects a stale one, which is what every `flows.sh` invocation relies on
 * to notice a sibling lane editing the harness mid-wave.
 *
 * The third is that the HEAD comparison agrees with git in both directions, so
 * `dirty-subject` cannot quietly stop reporting.
 *
 * The fourth is that the record is machine-independent: no absolute path, so a
 * committed wave record describes bytes rather than somebody's home directory.
 *
 * The fifth is that the stamp covers `packages/smithers/src`. That package is the
 * only one whose loaded bytes are a build, so it is the only one whose source
 * can drift away from what runs; leaving it out of the stamp is what let a
 * mid-wave CLI edit pass the pin when the same edit to any other package would
 * have stopped the wave. Held with `stampOf` against a changed input rather
 * than by writing into a shared working tree.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stampOf } from "../lib/subject.mjs"

const here = import.meta.dirname
const rig = resolve(here, "..")
const root = resolve(rig, "../..")
const subject = join(rig, "lib/subject.mjs")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-subject-"))

const run = (...args) => spawnSync(process.execPath, [subject, ...args], { encoding: "utf8", cwd: rig })

try {
  const reported = run("--json", "--quiet")
  assert.equal(reported.status, 0, reported.stderr)
  const fingerprint = JSON.parse(reported.stdout)

  // The fingerprint refuses rather than guessing when the preflight has not
  // run, and the refusal names what to do. Reading past it produces a
  // `TypeError` on an absent field, which is the wrong sentence for an
  // operator who simply has no build yet.
  assert.deepEqual(
    fingerprint.refusals ?? [],
    [],
    `the subject refused: ${(fingerprint.refusals ?? []).map((refusal) => refusal.message).join("; ")}`
  )
  assert.ok(fingerprint.stamp.startsWith("sha256:"), "the fingerprint carries a content stamp")

  // Every path in the record is repository-relative. A fingerprint states which
  // bytes ran; the absolute directory they ran in is a fact about a machine, and
  // one written into `scorecard.json` is how this rig arrived naming a checkout
  // that does not exist here.
  assert.equal(fingerprint.root, undefined, "the record carries no absolute checkout path")
  const absolute = JSON.stringify(fingerprint).match(/(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//)
  assert.equal(absolute, null, `the record names a machine's home directory: ${absolute?.[0]}`)
  assert.equal(
    fingerprint.marker.resolvedBy,
    "packages/smithers/agent/harness/src/CellTurn.ts",
    "the built CLI resolves the harness cell loop to source, not to packages/smithers/agent/harness/dist"
  )
  assert.equal(fingerprint.packages["@smthrs/cli"].loadsFrom, "dist", "the CLI is entered through its build")
  assert.equal(
    fingerprint.packages["@smthrs/cli"].resolvedEntry,
    "packages/smithers/dist/esm/bin.js",
    "the CLI's entry point is the binary flows.sh execs"
  )
  for (const [name, value] of Object.entries(fingerprint.packages)) {
    if (name === "@smthrs/cli") continue
    assert.equal(value.loadsFrom, "src", `${name} is loaded from source; a build of it would not be the subject`)
  }
  assert.ok(
    Object.keys(fingerprint.packages).length > 20,
    "the closure walk reaches the CLI's transitive dependencies, not only its direct ones"
  )
  assert.equal(
    fingerprint.refusals.filter((refusal) => refusal.code === "unresolvable").length,
    0,
    "every package in the closure resolves the way the running process resolves it"
  )

  // The CLI's source, and the stamp's dependence on it. `packages/smithers` is the
  // one package where "what is on disk" and "what runs" are two different
  // things, so a pin that only hashed the build could not tell a wave that the
  // build had gone stale under it.
  assert.ok(fingerprint.cliSrc.hash.startsWith("sha256:"), "the CLI's own source is fingerprinted")
  assert.ok(fingerprint.cliSrc.files > 0, "the CLI's source hash covers files")
  assert.equal(stampOf(fingerprint), fingerprint.stamp, "the stamp is a function of the reported record")
  assert.notEqual(
    stampOf({ ...fingerprint, cliSrc: { ...fingerprint.cliSrc, hash: "sha256:built-from-something-else" } }),
    fingerprint.stamp,
    "an edit to packages/smithers/src moves the stamp, so a wave stops until preflight rebuilds"
  )
  assert.notEqual(
    stampOf({ ...fingerprint, cliDist: { ...fingerprint.cliDist, hash: "sha256:another-build" } }),
    fingerprint.stamp,
    "a rebuilt CLI moves the stamp"
  )
  assert.equal(
    stampOf({ ...fingerprint, head: "0".repeat(40), node: "v0.0.0" }),
    fingerprint.stamp,
    "the stamp answers which bytes ran, not which commit or runtime was in the room"
  )

  // A path is counted once. A file tracked at HEAD and staged as deleted, which
  // is the state a shared jj-colocated index leaves behind, is reported by both
  // `git diff HEAD` and `git ls-files --others`.
  for (const [name, value] of Object.entries(fingerprint.packages)) {
    assert.equal(new Set(value.dirty).size, value.dirty.length, `${name} reports each differing path once`)
  }

  // The pin, in both directions.
  const pin = join(temporary, "subject.json")
  writeFileSync(pin, JSON.stringify(fingerprint))
  const matching = run("--expect", pin, "--quiet")
  assert.equal(matching.status, 0, matching.stderr)

  writeFileSync(pin, JSON.stringify({ ...fingerprint, stamp: "sha256:0000" }))
  const stale = run("--expect", pin, "--quiet")
  assert.equal(stale.status, 4, "a moved subject is refused, not warned about")
  assert.match(stale.stderr, /the subject changed since the preflight recorded it/)

  const absent = run("--expect", join(temporary, "nothing.json"), "--quiet")
  assert.equal(absent.status, 3, "an unpinned subject is refused")

  // The HEAD comparison agrees with git, whichever way the tree happens to be.
  for (
    const [name, directory] of [["@smthrs/harness", "packages/smithers/agent/harness/src"], [
      "@smthrs/cli",
      "packages/smithers/src"
    ]]
  ) {
    const diff = spawnSync("git", ["diff", "--name-only", "HEAD", "--", directory], { cwd: root, encoding: "utf8" })
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "--", directory], {
      cwd: root,
      encoding: "utf8"
    })
    const changed = `${diff.stdout}${untracked.stdout}`.trim().length > 0
    const refused = fingerprint.refusals.some((refusal) =>
      refusal.code === "dirty-subject" && refusal.message.startsWith(`${name} `)
    )
    assert.equal(
      refused,
      changed,
      changed
        ? `${directory} differs from HEAD and the fingerprint did not say so`
        : `${directory} matches HEAD and the fingerprint claimed otherwise`
    )
    assert.equal(fingerprint.packages[name].dirty.length > 0, changed)
  }

  console.log("check-subject.mjs: the subject fingerprint names what the CLI loads, and the pin is enforced.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
