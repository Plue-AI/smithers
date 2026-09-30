import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { findConflictMarkers, isMarkerLine } from "./check-conflict-markers.mjs"

const script = fileURLToPath(new URL("./check-conflict-markers.mjs", import.meta.url))

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}

/** A throwaway repository whose files are all tracked unless named in `untracked`. */
const repository = (t, files, untracked = {}) => {
  const root = mkdtempSync(join(tmpdir(), "conflict-markers-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, "init", "-q")
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  if (Object.keys(files).length > 0) git(root, "add", "--", ...Object.keys(files))
  for (const [path, contents] of Object.entries(untracked)) writeFileSync(join(root, path), contents)
  return root
}

const run = (root) => spawnSync(process.execPath, [script, root], { encoding: "utf8" })

// The block a1db0f6fe7 committed into GrantStoreHardening.test.ts, trimmed.
const jjConflict = [
  "  it.effect(\"accepts the metadata boundary\", () =>",
  "<<<<<<< conflict 1 of 1",
  "%%%%%%% diff from: xpztrsny b7552cfd \"fix(review): pin PR comparisons\" (parents of rebased revision)",
  "\\\\\\\\\\\\\\        to: vksnmmsy 86b6be07 \"fix(harbor): release failed startup slots\" (parents of squashed revision)",
  "   it.effect(\"preserves __proto__ metadata\", () =>",
  "-        const meta = JSON.parse('{}')",
  "+        const meta = JSON.parse(\"{}\")",
  "+++++++ lwrwyqzq 0347f302 (rebased revision)",
  ">>>>>>> conflict 1 of 1 ends",
  "  })",
  ""
].join("\n")

const gitConflict = ["<<<<<<< HEAD", "left", "||||||| base", "base", "=======", "right", ">>>>>>> topic", ""].join("\n")

test("recognizes every git and jj marker line", () => {
  for (
    const line of [
      "<<<<<<< conflict 1 of 2",
      ">>>>>>> conflict 2 of 2 ends",
      "%%%%%%% diff from: abc",
      "\\\\\\\\\\\\\\        to: def",
      "+++++++ side #2",
      "------- base",
      "<<<<<<< HEAD",
      "||||||| merged common ancestors",
      ">>>>>>> feature",
      "<<<<<<<",
      ">>>>>>>"
    ]
  ) assert.equal(isMarkerLine(line), true, line)
})

test("leaves text that only resembles a marker", () => {
  for (
    const line of [
      "=======",
      "Heading",
      "<<<<<<<< eight",
      ">>>>>>>> eight",
      "--------",
      "-------x",
      "+++++++x",
      " <<<<<<< indented",
      "\t>>>>>>> indented",
      "const marker = \"<<<<<<< HEAD\"",
      "<<<<<< six",
      "| ------- | table |"
    ]
  ) assert.equal(isMarkerLine(line), false, line)
})

test("finds nothing in a clean repository, including one with no tracked files", (t) => {
  assert.deepEqual(findConflictMarkers(repository(t, { "a.ts": "export const a = 1\n", "README.md": "Title\n=====\n" })), [])
  assert.deepEqual(findConflictMarkers(repository(t, {})), [])
})

test("reports each marker line of a committed jj conflict with its path and line", (t) => {
  const root = repository(t, { "test/Grant Store:Hardening.test.ts": jjConflict, "clean.ts": "ok\n" })
  assert.deepEqual(findConflictMarkers(root), [
    { path: "test/Grant Store:Hardening.test.ts", line: 2, text: "<<<<<<< conflict 1 of 1" },
    {
      path: "test/Grant Store:Hardening.test.ts",
      line: 3,
      text: "%%%%%%% diff from: xpztrsny b7552cfd \"fix(review): pin PR comparisons\" (parents of rebased revision)"
    },
    {
      path: "test/Grant Store:Hardening.test.ts",
      line: 4,
      text: "\\\\\\\\\\\\\\        to: vksnmmsy 86b6be07 \"fix(harbor): release failed startup slots\" (parents of squashed revision)"
    },
    { path: "test/Grant Store:Hardening.test.ts", line: 8, text: "+++++++ lwrwyqzq 0347f302 (rebased revision)" },
    { path: "test/Grant Store:Hardening.test.ts", line: 9, text: ">>>>>>> conflict 1 of 1 ends" }
  ])
})

test("reports a git conflict across files in git's order", (t) => {
  const root = repository(t, { "b.txt": gitConflict, "a/one.md": gitConflict })
  assert.deepEqual(findConflictMarkers(root).map(({ path, line }) => `${path}:${line}`), [
    "a/one.md:1",
    "a/one.md:3",
    "a/one.md:7",
    "b.txt:1",
    "b.txt:3",
    "b.txt:7"
  ])
})

test("ignores binary and untracked files", (t) => {
  const binary = Buffer.concat([Buffer.from(gitConflict), Buffer.from([0, 1, 2, 0])])
  const root = repository(t, { "image.bin": binary }, { "scratch.ts": gitConflict })
  assert.deepEqual(findConflictMarkers(root), [])
})

test("fails loudly outside a git repository rather than reporting it clean", (t) => {
  const root = mkdtempSync(join(tmpdir(), "conflict-markers-bare-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => findConflictMarkers(root), /git grep failed with status/)
  const cli = run(root)
  assert.equal(cli.status, 2)
  assert.match(cli.stderr, /^conflict markers: git grep failed with status \d+: /)
})

test("the command exits 1 naming every marker, and 0 on a clean tree", (t) => {
  const dirty = run(repository(t, { "src/x.ts": jjConflict }))
  assert.equal(dirty.status, 1)
  assert.match(dirty.stderr, /^src\/x\.ts:2: conflict marker: <<<<<<< conflict 1 of 1$/m)
  assert.match(dirty.stderr, /^src\/x\.ts:9: conflict marker: >>>>>>> conflict 1 of 1 ends$/m)
  assert.match(dirty.stderr, /conflict markers: 5 marker line\(s\) in 1 tracked file\(s\); resolve them/)
  const clean = run(repository(t, { "src/x.ts": "ok\n" }))
  assert.equal(clean.status, 0)
  assert.equal(clean.stdout, "conflict markers: none in tracked files\n")
})
