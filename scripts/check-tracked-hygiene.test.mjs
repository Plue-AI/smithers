import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  actionlintArguments,
  danglingFindings,
  findings,
  forbiddenFindings,
  formatFinding,
  isIgnored,
  listFiles,
  packageReferences,
  parseIgnore,
  scaffoldFindings,
  walkFiles
} from "./check-tracked-hygiene.mjs"

const script = fileURLToPath(new URL("./check-tracked-hygiene.mjs", import.meta.url))

/** A fixture tree: `files` maps path to contents; a value `{ link }` is a symlink. */
const tree = (t, files) => {
  const root = mkdtempSync(join(tmpdir(), "tracked-hygiene-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    if (typeof contents === "object") symlinkSync(contents.link, join(root, path))
    else writeFileSync(join(root, path), contents)
  }
  return root
}

const run = (root, files) =>
  spawnSync(process.execPath, [script, "--files-from-stdin", root], { encoding: "utf8", input: files.join("\0") })

const messages = (list) => list.map(formatFinding)

// ---- dangling references

const packageTs = (workflows) => `
const ci = Smithers.GithubCiGen({
  workflowLint: Smithers.CiToolchain.Actionlint({
    release: "1.7.11",
    workflows: [${workflows.map((w) => `"${w}"`).join(", ")}]
  })
})
`

test("dangling: a deleted workflow in the PACKAGE.ts actionlint list is named with file and line", () => {
  const files = ["PACKAGE.ts", ".github/workflows/ci.yml"]
  const read = () => packageTs([".github/workflows/ci.yml", ".github/workflows/release-auth.yml"])
  assert.deepEqual(messages(danglingFindings(files, read)), [
    'PACKAGE.ts:5: dangling: workflows names ".github/workflows/release-auth.yml", which no tracked file matches'
  ])
})

test("dangling: every listed workflow present passes", () => {
  const files = ["PACKAGE.ts", ".github/workflows/ci.yml", ".github/workflows/release.yml"]
  const read = () => packageTs([".github/workflows/ci.yml", ".github/workflows/release.yml"])
  assert.deepEqual(danglingFindings(files, read), [])
})

test("dangling: paths resolve against the package directory, then the root, and globs need a match", () => {
  const text = `const x = { paths: ["plue_env.py", "docs/*.md", "nested/**", ".github/workflows/*.yml", "gone.py", "none/*.ts"] }`
  const files = ["evals/PACKAGE.ts", "evals/plue_env.py", "docs/a.md", "evals/nested/deep/x.ts", ".github/workflows/ci.yml"]
  const found = danglingFindings(files, () => text)
  assert.deepEqual(messages(found), [
    'evals/PACKAGE.ts:1: dangling: paths names "gone.py", which no tracked file matches',
    'evals/PACKAGE.ts:1: dangling: paths names "none/*.ts", which no tracked file matches'
  ])
})

test("dangling: Smithers.file sources and brace globs resolve against the root", () => {
  const text = `srcs: [Smithers.file("//scripts/a.mjs"), Smithers.file("//scripts/gone.mjs"), Smithers.glob("//x/*.{py,md}")]`
  const files = ["PACKAGE.ts", "scripts/a.mjs", "x/one.md"]
  assert.deepEqual(messages(danglingFindings(files, () => text)), [
    'PACKAGE.ts:1: dangling: Smithers.file names "scripts/gone.mjs", which no tracked file matches'
  ])
})

test("dangling: a PACKAGE.ts under test fixtures describes the fixture and is not checked", () => {
  const files = ["pkg/test/fixtures/a/PACKAGE.ts"]
  assert.deepEqual(danglingFindings(files, () => `paths: ["nope"]`), [])
})

test("dangling: a generated workflow whose actionlint args name a deleted file is named", () => {
  const yml = [
    "jobs:",
    "  test:",
    "    steps:",
    '      - name: "Validate GitHub Actions workflows"',
    '        uses: "docker://rhysd/actionlint@sha256:abc"',
    "        with:",
    '          "args": ".github/workflows/ci.yml .github/workflows/native-windows.yml"'
  ].join("\n")
  const files = [".github/workflows/ci.yml"]
  assert.deepEqual(messages(danglingFindings(files, () => yml)), [
    '.github/workflows/ci.yml:7: dangling: actionlint is passed ".github/workflows/native-windows.yml", which no tracked file matches'
  ])
  assert.deepEqual(danglingFindings([...files, ".github/workflows/native-windows.yml"], () => yml), [])
})

test("dangling: extractors read both quoting styles and ignore non-path fields", () => {
  assert.deepEqual(packageReferences(`paths: { "*": ["./*"] }\nworkflows: ['a.yml']`).map((r) => r.path), ["a.yml"])
  assert.deepEqual(actionlintArguments("uses: x/actionlint@1\nwith:\n  args: a.yml b.yaml c.txt\n").map((r) => r.path), ["a.yml", "b.yaml"])
})

// ---- forbidden tracked files

test("forbidden: node_modules files and symlinks, bundler temp files and gitignored files are named", () => {
  const rules = parseIgnore("node_modules/\ndist/\n*.tsbuildinfo\n/.smithers/*\n!/.smithers/WORKSPACE.ts\n")
  const files = [
    "node_modules",
    "packages/a/node_modules",
    "packages/a/node_modules/x/index.js",
    "flows/coding/.smithers-35e97ae33074c50c174a90d629d94f35ec8f70baf0bb94f0560fcf54e818e689-7-murhou7y.ts",
    "packages/a/dist/index.js",
    "packages/a/tsconfig.tsbuildinfo",
    ".smithers/run.json",
    ".smithers/WORKSPACE.ts",
    "packages/a/src/index.ts",
    "packages/a/node_modules_notes.md"
  ]
  assert.deepEqual(messages(forbiddenFindings(files, rules)), [
    "node_modules: forbidden: tracked path has a node_modules segment (file or symlink); delete it",
    "packages/a/node_modules: forbidden: tracked path has a node_modules segment (file or symlink); delete it",
    "packages/a/node_modules/x/index.js: forbidden: tracked path has a node_modules segment (file or symlink); delete it",
    "flows/coding/.smithers-35e97ae33074c50c174a90d629d94f35ec8f70baf0bb94f0560fcf54e818e689-7-murhou7y.ts: forbidden: tracked bundler temp file (.smithers-<hex>-*.ts); delete it",
    "packages/a/dist/index.js: forbidden: tracked file that .gitignore excludes (build output or local state); untrack it",
    "packages/a/tsconfig.tsbuildinfo: forbidden: tracked file that .gitignore excludes (build output or local state); untrack it",
    ".smithers/run.json: forbidden: tracked file that .gitignore excludes (build output or local state); untrack it"
  ])
})

test("forbidden: a clean file list passes", () => {
  const rules = parseIgnore("node_modules/\ndist/\n")
  assert.deepEqual(forbiddenFindings(["src/a.ts", ".smithers/WORKSPACE.ts", ".smithers-notes.md"], rules), [])
})

test("gitignore matcher: anchoring, negation, ** and parent directories", () => {
  const rules = parseIgnore("# c\n\n/target\n**/.smithers/*.db\npackages/*/dist/\n!keep/dist/x\nfoo/**/bar\n*.log\n")
  assert.equal(isIgnored(rules, "target/debug/a"), true)
  assert.equal(isIgnored(rules, "crates/target/a"), false)
  assert.equal(isIgnored(rules, "a/b/.smithers/x.db"), true)
  assert.equal(isIgnored(rules, "packages/p/dist/a.js"), true)
  assert.equal(isIgnored(rules, "keep/dist/x"), false)
  assert.equal(isIgnored(rules, "foo/1/2/bar"), true)
  assert.equal(isIgnored(rules, "deep/er/out.log"), true)
})

// ---- lane scaffolding

const scaffold = (path, text) => scaffoldFindings([path], () => text)

test("scaffold: each scaffolding string in product code is named with file and line", () => {
  const text = [
    "const ok = 1",
    "export GOCACHE=$HOME/.cache/go-build-ins",
    "cd ~/smithers-mvp-lane2",
    'const dir = "/private/tmp/claude-501/x"',
    "see scratchpad/lanes/a"
  ].join("\n")
  assert.deepEqual(messages(scaffold("scripts/build.sh", text)), [
    "scripts/build.sh:2: scaffold: lane scaffolding go-build-<word> (lane-private Go cache): export GOCACHE=$HOME/.cache/go-build-ins",
    "scripts/build.sh:3: scaffold: lane scaffolding smithers-mvp- (lane worktree path): cd ~/smithers-mvp-lane2",
    'scripts/build.sh:4: scaffold: lane scaffolding /private/tmp/claude- (agent session path): const dir = "/private/tmp/claude-501/x"',
    "scripts/build.sh:5: scaffold: lane scaffolding scratchpad/lanes (agent scratch path): see scratchpad/lanes/a"
  ])
})

test("scaffold: product identities, .specs, docs, markdown, binary files and the check itself pass", () => {
  const dirty = "GOCACHE=/private/tmp/claude-1/go-build-x scratchpad/lanes"
  for (const path of [".specs/a.json", "docs/a.ts", "apps/site/docs/x.txt", "README.md", "scripts/check-tracked-hygiene.test.mjs"]) {
    assert.deepEqual(scaffold(path, dirty), [], path)
  }
  assert.deepEqual(scaffoldFindings(["a.png"], () => null), [])
  assert.deepEqual(scaffold("a.ts", 'worker: "smithers-mvp-web", k: "smithers-mvp-quarantine.x", go build -o bin'), [])
})

// ---- whole check

const dirtyTree = {
  ".gitignore": "node_modules/\ndist/\n",
  "PACKAGE.ts": packageTs([".github/workflows/ci.yml", ".github/workflows/deleted.yml"]),
  ".github/workflows/ci.yml": "name: ci\n",
  "src/a.ts": "const cache = '/private/tmp/claude-501/a'\n",
  "dist/out.js": "x\n",
  "pkg/node_modules": { link: "../elsewhere" }
}

test("whole check: findings and exit 1 on a dirty fixture; exit 0 on a clean one", (t) => {
  const root = tree(t, dirtyTree)
  const files = Object.keys(dirtyTree)
  const dirty = run(root, files)
  assert.equal(dirty.status, 1)
  assert.match(dirty.stderr, /^PACKAGE\.ts:5: dangling: workflows names "\.github\/workflows\/deleted\.yml"/m)
  assert.match(dirty.stderr, /^pkg\/node_modules: forbidden: tracked path has a node_modules segment/m)
  assert.match(dirty.stderr, /^dist\/out\.js: forbidden: tracked file that \.gitignore excludes/m)
  assert.match(dirty.stderr, /^src\/a\.ts:1: scaffold: lane scaffolding \/private\/tmp\/claude-/m)
  assert.match(dirty.stderr, /4 finding\(s\)/)

  const clean = tree(t, {
    ".gitignore": "node_modules/\n",
    "PACKAGE.ts": packageTs([".github/workflows/ci.yml"]),
    ".github/workflows/ci.yml": "name: ci\n"
  })
  const ok = run(clean, ["PACKAGE.ts", ".github/workflows/ci.yml", ".gitignore"])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /no dangling references/)
})

test("whole check: without a repository it walks the directory, skips ignored trees, and keeps symlinked node_modules", (t) => {
  const root = tree(t, { ...dirtyTree, "node_modules/x/index.js": "x\n", ".jj/store": "x\n" })
  assert.deepEqual(walkFiles(root, parseIgnore(dirtyTree[".gitignore"])), [".github/workflows/ci.yml", ".gitignore", "PACKAGE.ts", "pkg/node_modules", "src/a.ts"])
  rmSync(join(root, ".jj"), { recursive: true })
  const files = listFiles(root)
  assert.deepEqual(files, [".github/workflows/ci.yml", ".gitignore", "PACKAGE.ts", "pkg/node_modules", "src/a.ts"])
  assert.equal(findings(files, root).filter((f) => f.rule === "forbidden").length, 1)
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pkg\/node_modules: forbidden/)
})

test("whole check: an unreadable root is exit 2, not a clean pass", () => {
  const result = spawnSync(process.execPath, [script, join(tmpdir(), "no-such-root-tracked-hygiene")], { encoding: "utf8" })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /tracked hygiene:/)
})

const vcsOk = (root, command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test("Git listing distinguishes tracked files from landing candidates, excludes ignored files and retains empty repositories", (t) => {
  const root = tree(t, { ".gitignore": "ignored/\n", "tracked.ts": "export const value = 1\n" })
  vcsOk(root, "git", ["init"])
  assert.deepEqual(listFiles(root), [])
  vcsOk(root, "git", ["add", ".gitignore", "tracked.ts"])
  writeFileSync(join(root, "new\nfile.ts"), "export const value = 2\n")
  mkdirSync(join(root, "ignored"))
  writeFileSync(join(root, "ignored/output.ts"), "local\n")
  assert.deepEqual(listFiles(root), [".gitignore", "tracked.ts"])
  assert.deepEqual(listFiles(root, { includeUntracked: true }), [".gitignore", "new\nfile.ts", "tracked.ts"])
})

test("non-colocated jj listing snapshots landing candidates and preserves NUL-delimited paths", (t) => {
  const root = tree(t, { ".gitignore": "ignored/\n", "tracked.ts": "export const value = 1\n" })
  vcsOk(root, "jj", ["git", "init", "--no-colocate"])
  vcsOk(root, "jj", ["file", "list"])
  writeFileSync(join(root, "new\nfile.ts"), "export const value = 2\n")
  mkdirSync(join(root, "ignored"))
  writeFileSync(join(root, "ignored/output.ts"), "local\n")
  assert.deepEqual(listFiles(root), [".gitignore", "tracked.ts"])
  assert.deepEqual(listFiles(root, { includeUntracked: true }), [".gitignore", "new\nfile.ts", "tracked.ts"])
  assert.deepEqual(listFiles(root), [".gitignore", "new\nfile.ts", "tracked.ts"])
})

for (const vcsDirectory of [".git", ".jj"]) {
  test(`${vcsDirectory}: a broken repository listing fails closed in tracked and landing modes`, (t) => {
    const root = tree(t, { [`${vcsDirectory}/broken`]: "invalid repository\n", "source.ts": "clean\n" })
    assert.throws(() => listFiles(root), /file listing failed/)
    assert.throws(() => listFiles(root, { includeUntracked: true }), /file listing failed/)
    const result = spawnSync(process.execPath, [script, "--include-untracked", root], { encoding: "utf8" })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /tracked hygiene: .*file listing failed/)
  })
}

test("landing CLI checks fresh source while the default checks only tracked files", (t) => {
  const root = tree(t, { ".gitignore": "ignored/\n", "tracked.ts": "export const value = 1\n" })
  vcsOk(root, "git", ["init"])
  vcsOk(root, "git", ["add", "."])
  writeFileSync(join(root, "fresh.ts"), `const path = 'scratchpad/${"lanes"}/a'\n`)
  const tracked = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  assert.equal(tracked.status, 0, tracked.stderr)
  const landing = spawnSync(process.execPath, [script, "--include-untracked", root], { encoding: "utf8" })
  assert.equal(landing.status, 1)
  assert.match(landing.stderr, /fresh\.ts:1: scaffold: lane scaffolding/)
})

test("landing candidates omit unstaged deletions so references fail, and retain dangling symlinks", (t) => {
  const root = tree(t, {
    "PACKAGE.ts": "const target = { paths: ['source.ts'] }\n",
    "source.ts": "export const value = 1\n",
    "link": { link: "missing-target" }
  })
  vcsOk(root, "git", ["init"])
  vcsOk(root, "git", ["add", "."])
  rmSync(join(root, "source.ts"))
  assert.deepEqual(listFiles(root), ["PACKAGE.ts", "link", "source.ts"])
  assert.deepEqual(listFiles(root, { includeUntracked: true }), ["PACKAGE.ts", "link"])
  const result = spawnSync(process.execPath, [script, "--include-untracked", root], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /PACKAGE\.ts:1: dangling: paths names "source\.ts", which no tracked file matches/)
})

test("landing candidate filesystem errors fail closed instead of silently dropping paths", (t) => {
  const root = tree(t, { "nested/source.ts": "export const value = 1\n" })
  vcsOk(root, "git", ["init"])
  vcsOk(root, "git", ["add", "."])
  rmSync(join(root, "nested"), { recursive: true })
  writeFileSync(join(root, "nested"), "a file now occupies the directory\n")
  assert.deepEqual(listFiles(root), ["nested/source.ts"])
  assert.throws(() => listFiles(root, { includeUntracked: true }), { code: "ENOTDIR" })
  const result = spawnSync(process.execPath, [script, "--include-untracked", root], { encoding: "utf8" })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /tracked hygiene: .*ENOTDIR/)
})

test("projected tree omits only the ignored injected root dependency symlink", (t) => {
  const dependencies = tree(t, { "node_modules/package/index.js": "installed dependency\n" })
  const root = tree(t, {
    ".gitignore": "node_modules/\n",
    "node_modules": { link: join(dependencies, "node_modules") },
    "pkg/node_modules": { link: "../../missing" },
    "source.ts": "export const value = 1\n"
  })
  assert.deepEqual(listFiles(root), [".gitignore", "node_modules", "pkg/node_modules", "source.ts"])
  assert.deepEqual(listFiles(root, { projectedTree: true }), [".gitignore", "pkg/node_modules", "source.ts"])
  const result = spawnSync(process.execPath, [script, "--projected-tree", root], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pkg\/node_modules: forbidden/)
  assert.doesNotMatch(result.stderr, /^node_modules: forbidden/m)
  rmSync(join(root, "pkg"), { recursive: true })
  const clean = spawnSync(process.execPath, [script, "--projected-tree", root], { encoding: "utf8" })
  assert.equal(clean.status, 0, clean.stderr)
  // An explicit inventory always describes source files, never injected runtime paths.
  const explicit = spawnSync(process.execPath, [script, "--projected-tree", "--files-from-stdin", root], {
    encoding: "utf8", input: "node_modules\0"
  })
  assert.equal(explicit.status, 1)
  assert.match(explicit.stderr, /^node_modules: forbidden/m)
})

test("projected mode retains relative, broken and unrelated absolute root links", (t) => {
  const dependencies = tree(t, { "node_modules/package/index.js": "installed dependency\n", "other/index.js": "other\n" })
  for (const target of ["../node_modules", join(dependencies, "missing/node_modules"), join(dependencies, "other")]) {
    const root = tree(t, { ".gitignore": "node_modules/\n", "node_modules": { link: target } })
    assert.deepEqual(listFiles(root, { projectedTree: true }), [".gitignore", "node_modules"])
    const result = spawnSync(process.execPath, [script, "--projected-tree", root], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^node_modules: forbidden/m)
  }
})

test("projected mode retains unignored root symlinks and ignored root ordinary files", (t) => {
  const unignored = tree(t, { "node_modules": { link: "/missing/dependencies" } })
  assert.deepEqual(listFiles(unignored, { projectedTree: true }), ["node_modules"])
  const file = tree(t, { ".gitignore": "node_modules/\n", "node_modules": "ordinary source file\n" })
  assert.deepEqual(listFiles(file, { projectedTree: true }), [".gitignore", "node_modules"])
  for (const root of [unignored, file]) {
    const result = spawnSync(process.execPath, [script, "--projected-tree", root], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^node_modules: forbidden/m)
  }
})

test("projected mode still refuses actual tracked root dependency symlinks", (t) => {
  const root = tree(t, { ".gitignore": "node_modules/\n", "node_modules": { link: "/missing/dependencies" } })
  vcsOk(root, "git", ["init"])
  vcsOk(root, "git", ["add", "-f", ".gitignore", "node_modules"])
  assert.deepEqual(listFiles(root, { projectedTree: true }), [".gitignore", "node_modules"])
  for (const mode of [[], ["--include-untracked"]]) {
    const result = spawnSync(process.execPath, [script, "--projected-tree", ...mode, root], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^node_modules: forbidden/m)
  }
})

test("an absent ignore file is supported but an unreadable ignore path fails closed", (t) => {
  const root = tree(t, { "source.ts": "export const value = 1\n" })
  assert.deepEqual(findings(["source.ts"], root), [])
  mkdirSync(join(root, ".gitignore"))
  assert.throws(() => findings(["source.ts"], root), { code: "EISDIR" })
  const result = run(root, ["source.ts"])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /tracked hygiene: .*EISDIR/)
})

test("an inventoried PACKAGE directory fails closed rather than reading as empty source", (t) => {
  const root = tree(t, { "PACKAGE.ts/child": "not a source file\n" })
  assert.throws(() => findings(["PACKAGE.ts"], root), { code: "EISDIR" })
  const result = run(root, ["PACKAGE.ts"])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /tracked hygiene: .*EISDIR/)
})

test("missing inventoried source files fail closed while nonfiles and binary or large sources remain exempt", (t) => {
  const root = tree(t, {
    "directory/child": "not inventoried\n",
    "link.ts": { link: "missing-target" },
    "binary.ts": "\0scratchpad/lanes\n",
    "large.ts": "x".repeat(4 * 1024 * 1024 + 1)
  })
  assert.deepEqual(findings(["directory", "link.ts", "binary.ts", "large.ts"], root), [])
  for (const source of ["missing.ts", "PACKAGE.ts"]) {
    assert.throws(() => findings([source], root), { code: "ENOENT" })
    const result = run(root, [source])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /tracked hygiene: .*ENOENT/)
  }
})
