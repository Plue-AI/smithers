/**
 * Asserts that patch capture reports the agent's edits and nothing else.
 *
 *   node fixtures/check-capture.mjs
 *
 * The rig's two historical contaminants are reproduced here with plain git, no
 * docker and no dataset:
 *
 *   1. The official images mutate tracked files in `pre_install`
 *      (sphinx-doc__sphinx-11445 seds `-rA` into `tox.ini`). A diff against the
 *      base commit reports that churn as the agent's, and it reverse-applies at
 *      grading, which voided every sphinx verdict from waves 2 through 4.
 *   2. The flows durability snapshot writes the whole working tree into git's
 *      index, so scratch the agent created is tracked by capture time. Wave 3
 *      shipped `.tmp_init_collect_repro/` with an `assert False` in it.
 *
 * Both shapes of image are covered: one that commits its `pre_install` churn
 * (what the sphinx image does) and one that leaves it in the worktree.
 */
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-capture-"))

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const run = (script, ...args) => execFileSync(join(root, script), args, { cwd: root, encoding: "utf8" }).trim()

/** A testbed the way an official image ships one: a base commit, then churn. */
const makeTestbed = (name, { commitChurn }) => {
  const work = join(temporary, name)
  mkdirSync(work, { recursive: true })
  git(work, "init", "--quiet")
  git(work, "config", "user.name", "image")
  git(work, "config", "user.email", "image@localhost")
  writeFileSync(join(work, "src.py"), "value = 1\n")
  writeFileSync(join(work, "tox.ini"), "commands=\n    pytest --durations 25\n")
  git(work, "add", "-A")
  git(work, "commit", "--quiet", "-m", "base")
  const base = git(work, "rev-parse", "HEAD")
  writeFileSync(join(work, "tox.ini"), "commands=\n    pytest -rA --durations 25\n")
  if (commitChurn) {
    git(work, "add", "-A")
    git(work, "commit", "--quiet", "-m", "pre_install")
  }
  return { work, base }
}

try {
  for (const commitChurn of [true, false]) {
    const label = commitChurn ? "churn committed" : "churn unstaged"
    const { work, base } = makeTestbed(commitChurn ? "committed" : "unstaged", { commitChurn })
    if (commitChurn) {
      git(work, "pack-refs", "--all")
      git(work, "update-index", "--split-index")
    }

    const imageIndex = readFileSync(join(work, ".git", "index"))
    const captureBase = run("lib/snapshot-base.sh", work)
    assert.match(captureBase, /^[0-9a-f]{40}$/, `${label}: capture base is a commit`)
    assert.deepEqual(
      readFileSync(join(work, ".git", "index")),
      imageIndex,
      `${label}: snapshot leaves the task index unchanged`
    )

    // No agent runs. The captured patch must be empty: the image's own churn is
    // in the capture base, so it cancels.
    const empty = join(temporary, `${commitChurn}-empty.patch`)
    run("lib/capture-patch.sh", work, empty)
    assert.equal(readFileSync(empty, "utf8"), "", `${label}: a run with no agent captures an empty patch`)

    // Now the agent: one real edit, plus scratch, plus the durability sweep that
    // puts everything the working tree holds into git's index.
    writeFileSync(join(work, "src.py"), "value = 2\n")
    mkdirSync(join(work, ".tmp_init_collect_repro"), { recursive: true })
    writeFileSync(join(work, ".tmp_init_collect_repro/test_repro.py"), "assert False\n")
    git(work, "add", "-A")

    const agentIndex = readFileSync(join(work, ".git", "index"))
    const patchPath = join(temporary, `${commitChurn}.patch`)
    run("lib/capture-patch.sh", work, patchPath)
    assert.deepEqual(
      readFileSync(join(work, ".git", "index")),
      agentIndex,
      `${label}: capture leaves the task index unchanged`
    )
    const patch = readFileSync(patchPath, "utf8")

    assert.match(patch, /^diff --git a\/src\.py b\/src\.py$/m, `${label}: the agent's edit is captured`)
    assert.match(patch, /^\+value = 2$/m, `${label}: the edit's content is captured`)
    assert.doesNotMatch(patch, /tox\.ini/, `${label}: the image's pre_install churn is not captured`)
    assert.doesNotMatch(patch, /-rA/, `${label}: the image's pre_install churn is not captured`)
    assert.doesNotMatch(patch, /_init_collect_repro/, `${label}: agent scratch is not captured`)
    assert.doesNotMatch(patch, /assert False/, `${label}: agent scratch is not captured`)
    assert.equal(patch.split("diff --git ").length - 1, 1, `${label}: exactly one file section`)

    // What was dropped is recorded, so a wave can see a file it meant to keep.
    const dropped = readFileSync(`${patchPath}.untracked`, "utf8").split("\n").filter(Boolean)
    assert.deepEqual(dropped, [".tmp_init_collect_repro/test_repro.py"], `${label}: the dropped files are listed`)

    // The hunk context comes from the pristine post-install tree, not from the
    // agent, and the capture base is that tree — churn included, so it cancels.
    assert.match(patch, /^-value = 1$/m, `${label}: the hunk is against the pre-agent content`)
    assert.equal(
      git(work, "show", `${captureBase}:tox.ini`),
      "commands=\n    pytest -rA --durations 25",
      `${label}: the capture base carries the image's pre_install churn`
    )
    assert.equal(
      git(work, "show", `${base}:tox.ini`),
      "commands=\n    pytest --durations 25",
      `${label}: the base commit does not`
    )
  }

  // Repository config is container-controlled. Exercise each execution surface
  // separately so one helper cannot hide another. Install it both before the
  // image snapshot and after the agent starts, with the marker outside /testbed.
  const hostileCases = {
    external: (work, helper) => git(work, "config", "diff.external", helper),
    textconv: (work, helper) => {
      writeFileSync(join(work, ".gitattributes"), "src.py diff=hostile\n")
      git(work, "config", "diff.hostile.textconv", helper)
    },
    filter: (work, helper) => {
      writeFileSync(join(work, ".gitattributes"), "src.py filter=hostile\n")
      git(work, "config", "filter.hostile.clean", helper)
    },
    fsmonitor: (work, helper) => git(work, "config", "core.fsmonitor", helper),
    hooks: (work, helper) => {
      const hooks = join(work, ".git", "hostile-hooks")
      mkdirSync(hooks)
      writeFileSync(join(hooks, "reference-transaction"), readFileSync(helper), { mode: 0o755 })
      git(work, "config", "core.hooksPath", hooks)
    },
    include: (work, helper) => {
      const config = join(work, ".git", "hostile-config")
      writeFileSync(config, `[diff]\n external = ${helper}\n`)
      git(work, "config", "include.path", config)
    },
    global: (work, helper) => {
      const config = join(temporary, "global-config")
      writeFileSync(config, `[core]\n fsmonitor = ${helper}\n[diff]\n external = ${helper}\n`)
      return { GIT_CONFIG_GLOBAL: config }
    },
    environment: (work, helper) => {
      writeFileSync(join(work, ".gitattributes"), "src.py filter=hostile\n")
      return {
        GIT_EXTERNAL_DIFF: helper,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "filter.hostile.clean",
        GIT_CONFIG_VALUE_0: helper,
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='" + helper + "'"
      }
    },
    malformed: (work) => {
      // Fails even rev-parse if the host reads this config at all.
      writeFileSync(join(work, ".git", "config"), "[invalid\n")
    }
  }
  const failures = []
  for (const [name, install] of Object.entries(hostileCases)) {
    for (const phase of ["snapshot", "capture"]) {
      const label = `${phase}-${name}`
      const { work } = makeTestbed(label, { commitChurn: false })
      const marker = join(temporary, `${label}.executed`)
      const helper = join(temporary, `${label}.sh`)
      writeFileSync(helper, `#!/bin/sh\nprintf executed >> '${marker}'\nif [ "$#" -eq 0 ]; then cat; fi\n`, {
        mode: 0o755
      })
      if (phase === "capture") run("lib/snapshot-base.sh", work)
      const env = { ...process.env, ...install(work, helper) }
      if (phase === "snapshot") {
        const result = spawnSync(join(root, "lib/snapshot-base.sh"), [work], { encoding: "utf8", env, timeout: 10_000 })
        if (result.status !== 0) failures.push(`${label}: snapshot exited ${result.status}: ${result.stderr}`)
        if (existsSync(marker)) failures.push(`${label}: helper executed on host during snapshot`)
      }
      writeFileSync(join(work, "src.py"), "value = 2\n")
      const patchPath = join(temporary, `${label}.patch`)
      const result = spawnSync(join(root, "lib/capture-patch.sh"), [work, patchPath], {
        encoding: "utf8",
        env,
        timeout: 10_000
      })
      if (result.status !== 0) failures.push(`${label}: capture exited ${result.status}: ${result.stderr}`)
      if (existsSync(marker)) failures.push(`${label}: helper executed on host`)
      const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : ""
      if (
        !/^-value = 1$/m.test(patch) || !/^\+value = 2$/m.test(patch) ||
        patch.split("diff --git ").length - 1 !== 1 || /tox\.ini/.test(patch)
      ) {
        failures.push(`${label}: patch does not contain exactly the agent's edit`)
      }
    }
  }
  assert.deepEqual(failures, [], "hostile Git configuration must never execute helpers or corrupt capture")

  // A workspace with no capture base is refused, not captured against the base
  // commit behind the operator's back.
  const stale = join(temporary, "stale")
  mkdirSync(stale, { recursive: true })
  git(stale, "init", "--quiet")
  git(stale, "config", "user.name", "image")
  git(stale, "config", "user.email", "image@localhost")
  writeFileSync(join(stale, "src.py"), "value = 1\n")
  git(stale, "add", "-A")
  git(stale, "commit", "--quiet", "-m", "base")
  const refused = execFileSync(
    "bash",
    [
      "-c",
      `"${join(root, "lib/capture-patch.sh")}" "${stale}" "${join(temporary, "stale.patch")}" 2>&1; echo "exit:$?"`
    ],
    { encoding: "utf8" }
  )
  assert.match(refused, /exit:3/, "a workspace with no capture base exits 3")
  assert.match(refused, /predates the capture fix/, "the refusal says why")
  assert.equal(existsSync(join(temporary, "stale.patch")), false, "the refusal writes no patch")

  // Mode cleanup drops only permission-bit sections; a rename or copy with no
  // content hunks is still the agent's change.
  const strip = (name, text) => {
    const patchPath = join(temporary, `${name}.patch`)
    writeFileSync(patchPath, text)
    execFileSync("node", [join(root, "lib/strip-modes.mjs"), patchPath], { encoding: "utf8" })
    return readFileSync(patchPath, "utf8")
  }
  const pureRename = "diff --git a/old.py b/new.py\nsimilarity index 100%\nrename from old.py\nrename to new.py\n"
  assert.equal(strip("pure-rename", pureRename), pureRename, "a pure rename is kept")
  const modeRename =
    "diff --git a/old.py b/new.py\nold mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from old.py\nrename to new.py\n"
  assert.match(
    strip("mode-rename", modeRename),
    /^rename from old\.py\nrename to new\.py$/m,
    "a rename with a mode change keeps the rename"
  )
  const pureCopy = "diff --git a/old.py b/copy.py\nsimilarity index 100%\ncopy from old.py\ncopy to copy.py\n"
  assert.equal(strip("pure-copy", pureCopy), pureCopy, "a pure copy is kept")
  const modeOnly = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n"
  assert.equal(strip("mode-only", modeOnly + pureRename), pureRename, "a pure mode change is dropped")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log(
  "check-capture.mjs: 2 capture scenarios, 18 hostile-config scenarios, missing-ref refusal and mode cleanup passed."
)
