/**
 * No operator rig may name one machine's home directory.
 *
 * `evals/swebench` is operator-run tooling that arrived from another checkout,
 * and it arrived carrying that checkout's absolute directory — `/Users`, an
 * operator's name, `flows/flows` — in a committed measurement record. A path
 * like that is invisible until somebody else runs the rig: it resolves to
 * nothing on their machine, and the record it sits in claims to describe a
 * checkout that is not the one under test.
 *
 * The gate's own prose therefore names no such path either. Writing the example
 * out is what tripped it the first time it ran over `scripts/`.
 *
 * So the gate is a class, not one file. Every tracked file under `evals/`,
 * `scripts/` and every package's `test/faults` tree is read, and any absolute
 * home-directory path in it fails. The local VCS supplies the file list, because the
 * untracked working files a wave leaves behind — pinned subjects, extracted
 * testbeds, virtualenvs — legitimately hold absolute paths and are gitignored
 * for exactly that reason.
 *
 * It covers the fault trees because the same mistake landed there under its own
 * name, while they were still a standalone `e2e/` member: a debug probe
 * committed with the author's checkout path in a dynamic `import`, which runs
 * on one machine and throws on every other. The cases moved into the packages
 * they test; the class of mistake did not move with them.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

/**
 * A home directory belonging to a person: `/Users/<name>` on macOS,
 * `/home/<name>` on Linux, the superuser's `root` home (also under
 * macOS's `/var`), the shell's `~<name>` home, and `C:\\Users\\<name>` on
 * Windows, however many times its backslashes are escaped. A name must
 * start with a letter, digit or underscore, so `/home`, `/Users/<name>` and
 * `/home/...` as concepts pass while `/Users/<name>` followed by any
 * punctuation fails. `root` must stand alone as the first path segment, so
 * `/rootfs`, `src/root` and `<runId>/root` pass. `~<name>` must end at a
 * slash, a quote or the line end and must not follow a word character or
 * another `~`, so `~/x`, `~~gone~~` Markdown strikethrough and `a~b` pass.
 *
 * Known limits, left for readability over recall: `~<name>` followed by
 * other punctuation (`~name;`, `~name:`, `~name|`, `~name &&`), and `root`
 * below another segment (`/private/var/root`) or after `{`, are not matched.
 */
export const homePath = /(?:\/Users|\/home)\/[A-Za-z0-9_][A-Za-z0-9._-]*|(?<=^|[\s"'`=(:[])(?:\/var)?\/root(?=[\/\s"'`;:,)\]]|$)|(?<![\w~])~[A-Za-z_][A-Za-z0-9_-]*(?=[\/"'`]|$)|\b[A-Za-z]:\\+Users\\+[A-Za-z0-9._ -]+/

/** The paths this gate reads, as `git ls-files` pathspecs. */
// `git ls-files` pathspecs. `*` crosses directory separators here, and the
// trailing `/*` is what makes the wildcard form match files rather than a
// directory name, so one entry reaches every `test/faults` tree whatever depth
// its package sits at. Packages nest — a granular package lives inside the
// product package it belongs to — and a depth-bound spelling would silently
// stop reading most of the matrix.
const scanned = ["evals", "scripts", "packages/*/test/faults/*"]

/** Every tracked file under {@link scanned}, as repository-relative paths. */
const tracked = (repositoryRoot = root, run = spawnSync) => {
  const git = existsSync(join(repositoryRoot, ".git"))
  const command = git ? "git" : "jj"
  // A hygiene check reads the last tracked inventory; it must not snapshot
  // edits or integrate concurrent jj operations just to enumerate paths.
  const args = git ? ["ls-files", "--", ...scanned] : ["file", "list", "--ignore-working-copy"]
  const result = run(command, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, `${command} inventory failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.split("\n").filter((path) =>
    path.startsWith("evals/") || path.startsWith("scripts/") || /^packages\/.+\/test\/faults\/.+/.test(path)
  )
}

/**
 * Recorded material, exempt because rewriting it would falsify a record rather
 * than fix a path.
 *
 * - `evals/swebench/reports/` and `evals/swebench/archive/` are wave write-ups.
 *   They quote the commands an operator ran on the machine that ran them, and
 *   they are read by people, never by the rig.
 * - `evals/authoring/data/` is a captured supervised-fine-tuning corpus. Its
 *   assistant turns are transcripts; editing a path inside one would change
 *   what a model was shown.
 */
const isRecorded = (path) =>
  path.startsWith("evals/swebench/reports/")
  || path.startsWith("evals/swebench/archive/")
  || path.startsWith("evals/authoring/data/")

describe("the rigs and gates outside the packages", () => {
  it("has files to check", () => {
    assert.ok(tracked().length > 0, `VCS inventory found no tracked file under ${scanned.join(", ")}`)
  })

  it("names no machine's home directory in a file the rig reads", () => {
    const offenders = []
    for (const path of tracked()) {
      if (isRecorded(path)) continue
      let content
      try {
        content = readFileSync(join(root, path), "utf8")
      } catch {
        continue
      }
      for (const [index, line] of content.split("\n").entries()) {
        const found = homePath.exec(line)
        if (found !== null) offenders.push(`${path}:${index + 1} ${found[0]}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a rig that hard-codes one machine's home directory resolves to nothing on anybody else's:\n  "
        + offenders.join("\n  ")
    )
  })
})

// Inventory selection must stop at this workspace, even when an unrelated
// ancestor has a Git repository. Only the local marker selects Git.
it("uses the jj inventory without a local .git and keeps the same scan boundary", () => {
  const fixture = mkdtempSync(join(tmpdir(), "machine-path-inventory-"))
  try {
    mkdirSync(join(fixture, ".jj"))
    const files = tracked(fixture, (command, args, options) => {
      assert.equal(command, "jj")
      assert.deepEqual(args, ["file", "list", "--ignore-working-copy"])
      assert.equal(options.cwd, fixture)
      return { status: 0, stdout: "scripts/probe.mjs\nevals/rig.ts\npackages/product/nested/test/faults/probe.ts\npackages/product/src/index.ts\napps/site/index.ts\n", stderr: "" }
    })
    assert.deepEqual(files, ["scripts/probe.mjs", "evals/rig.ts", "packages/product/nested/test/faults/probe.ts"])
    mkdirSync(join(fixture, ".git"))
    assert.deepEqual(tracked(fixture, (command, args) => {
      assert.equal(command, "git")
      assert.deepEqual(args, ["ls-files", "--", ...scanned])
      return { status: 0, stdout: "scripts/probe.mjs\n", stderr: "" }
    }), ["scripts/probe.mjs"])
    assert.throws(() => tracked(fixture, () => ({ status: 1, stdout: "", stderr: "inventory unavailable" })), /inventory unavailable/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

it("matches every home-directory spelling and leaves the concepts alone", () => {
  const person = ["na", "me"].join("")
  for (const line of [
    `const p = "/Users/${person}/src"`,
    `const p = "/Users/${person}"`,
    `cd /home/${person}`,
    `cwd: '/home/${person}'`,
    `cat /${"root"}/.bashrc`,
    `C:\\Users\\${person}\\src`,
    `"C:\\\\Users\\\\${person}"`,
    `"C:\\\\\\\\Users\\\\\\\\${person}"`,
    `cd /Users/${person};`,
    `(/Users/${person})`,
    `/Users/${person},`,
    `PATH=/Users/${person}:`,
    `cd /${"root"}`,
    `cd /var/${"root"}/src`,
    `[/${"root"}]`,
    `cd ~${person}/src`,
    `"~${person}"`,
    `ls ~${person}`
  ]) assert.ok(homePath.test(line), line)
  for (const line of ["macOS keeps homes under /Users", "the /home directory", "see /Users/<name>/ for an example", "/home/.../x", "/rootfs/x", "src/root/x", "/root-ca.pem", "<runId>/root", "~/x", "cd ~/src", "~~gone~~", "a~b/c", "about ~5 minutes", "~ approx"]) {
    assert.ok(!homePath.test(line), line)
  }
})
