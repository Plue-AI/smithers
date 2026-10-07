#!/usr/bin/env node
// Lists the backend access-control tests //:backendGoAccess runs (#3071).
//
// The selection is by file name, never by test-name keyword: every top-level
// `func TestX(t *testing.T)` in a matching `_test.go` file of the four access
// packages. The committed list (scripts/backend-access-tests.json) is checked
// against the files, so a new security test file cannot be silently left out.
//
//   node scripts/backend-access-tests.mjs --write   regenerate the list
//   node scripts/backend-access-tests.mjs --check   exit 1 when the list drifted
//   node scripts/backend-access-tests.mjs --runs    print "<package dir>\t<regex>" per file
//
// `--runs` emits one anchored alternation per file, so the target runs each
// file as its own `go test` process: a hang in one file panics only that
// process and cannot hide the access tests in the files that sort after it.
// It selects from the files on disk, never the committed list, so a stale list
// warns but still runs every access test; //:backendAccessTests (the drift
// workflow) is what fails on a stale list.
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const packages = [
  "packages/backend/internal/compose",
  "packages/backend/internal/services",
  "packages/backend/internal/identity",
  "packages/backend/internal/middleware"
]

const filePatterns = [
  /member/,
  /admission/,
  /authoriz/,
  /credential/,
  /person/,
  /dead_credential/,
  /secrets_write/,
  /external_read/,
  /admin_person/,
  /^install_owner_scope/
]

const testFunc = /^func (Test\w+)\(\s*\w+\s+\*testing\.T\s*\)/gm

/** Whether a file name belongs to the access set. */
export const selectsFile = (name) => name.endsWith("_test.go") && filePatterns.some((pattern) => pattern.test(name))

/** The top-level test names a Go source declares, in source order. */
export const testNames = (source) => [...source.matchAll(testFunc)].map((match) => match[1])

/** The access set under `root`: one entry per matching file that declares a test. */
export const collect = (root) =>
  packages.flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter(selectsFile)
      .sort()
      .map((file) => ({ package: dir, file, tests: testNames(readFileSync(join(root, dir, file), "utf8")) }))
      .filter((entry) => entry.tests.length > 0)
  )

/** The anchored `go test -run` alternation for a list of test names. */
export const runPattern = (tests) => `^(${tests.join("|")})$`

export const render = (entries) => `${JSON.stringify(entries, null, 2)}\n`

const drift =
  "scripts/backend-access-tests.json drifted from the access test files; run `node scripts/backend-access-tests.mjs --write` and commit it"

const read = (path) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

const main = () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const listPath = join(root, "scripts/backend-access-tests.json")
  const [mode] = process.argv.slice(2)
  const current = render(collect(root))
  if (mode === "--write") {
    writeFileSync(listPath, current)
    return 0
  }
  if (mode === "--runs") {
    if (read(listPath) !== current) process.stderr.write(`warning: ${drift}\n`)
    for (const entry of JSON.parse(current)) process.stdout.write(`${entry.package}\t${runPattern(entry.tests)}\n`)
    return 0
  }
  if (mode === "--check") {
    if (read(listPath) === current) return 0
    process.stderr.write(`${drift}\n`)
    return 1
  }
  process.stderr.write("usage: backend-access-tests.mjs --write | --check | --runs\n")
  return 2
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main()
