import { installMigrationFixture, registry } from './migration-fixture.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const go = spawnSync('which', ['go'], { encoding: 'utf8' }).stdout.trim()
const invoke = (cwd, bin, args, extra = {}) => {
 const env = { ...process.env, ...extra, HOME: join(cwd, '.git/test-home') }
 for (const key of Object.keys(env)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/.test(key) || ['DATABASE_URL', 'SMITHERS_TEST_DATABASE_URL', 'SMITHERS_GITHUB_PROXY'].includes(key)) delete env[key]
 }
 return spawnSync(bin, args, { cwd, encoding: 'utf8', env })
}
const ok = (cwd, bin, args, extra) => {
 const r = invoke(cwd, bin, args, extra); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout.trim()
}
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'prc02-'))
 installMigrationFixture(dir)
 ok(dir, 'git', ['init', '-b', 'main']);ok(dir, 'git', ['config', 'user.name', 'Fixture']);ok(dir, 'git', ['config', 'user.email', 'fixture@example.invalid']);ok(dir, 'git', ['add', '.']);ok(dir, 'git', ['commit', '-m', 'baseline']);ok(dir, 'git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
 return dir
}
function bytes(dir) {
 const result = {};const walk = (base, prefix = '') => {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
   if (['.git', 'node_modules', '.flows'].includes(entry.name)) continue
   const name = join(prefix, entry.name)
   if (entry.isDirectory()) walk(join(base, entry.name), name)
   else result[name] = readFileSync(join(base, entry.name)).toString('base64')
  }
 };walk(dir);return result
}
function pending(dir, number = '0009', status = 'planned:T-TEST-01;owner:smithers-8a') {
 const p = join(dir, 'packages/backend/db/product')
 writeFileSync(join(p, `migrations/${number}_reserved.sql`), 'CREATE TABLE reserved(id bigint PRIMARY KEY);\n')
 writeFileSync(join(p, 'migrate.go'), registry(`{${Number(number)}, "migrations/${number}_reserved.sql"},`))
 writeFileSync(join(dir, 'packages/backend/db/ownership.csv'), `table,target_owner,status\nthings,product,installed\nreserved,product,${status}\n`)
}

test('production helper: renumber, real pinned sqlc, reservation conversion, landed-byte preservation and refusals', () => {
 const dir = fixture()
 try {
  const landed = readFileSync(join(dir, 'packages/backend/db/product/migrations/0001_things.sql'))
  pending(dir)
  ok(dir, 'node', ['scripts/renumber-migration.mjs', 'packages/backend/db/product/migrations/0009_reserved.sql'], { SMITHERS_MIGRATION_TICKET: 'T-TEST-01' })
  assert.equal(readFileSync(join(dir, 'packages/backend/db/product/migrations/0002_reserved.sql'), 'utf8'), 'CREATE TABLE reserved(id bigint PRIMARY KEY);\n')
  assert.match(readFileSync(join(dir, 'packages/backend/db/product/migrate.go'), 'utf8'), /\{2, "migrations\/0002_reserved.sql"\}/)
  assert.equal(readFileSync(join(dir, 'packages/backend/db/ownership.csv'), 'utf8'), 'table,target_owner,status\nthings,product,installed\nreserved,product,product migration 0002;owner:smithers-8a\n')
  assert.match(readFileSync(join(dir, 'packages/backend/internal/db/models.go'), 'utf8'), /type Reserved struct/)
  assert.deepEqual(readFileSync(join(dir, 'packages/backend/db/product/migrations/0001_things.sql')), landed)
  for (const missing of [false, true]) {
   if (missing) ok(dir, 'git', ['update-ref', '-d', 'refs/remotes/origin/main'])
   const before = bytes(dir)
   const result = invoke(dir, 'node', ['scripts/renumber-migration.mjs', 'packages/backend/db/product/migrations/0001_things.sql'])
   assert.notEqual(result.status, 0);assert.match(result.stderr, missing ? /origin\/main/ : /already on origin\/main/);assert.deepEqual(bytes(dir), before)
  }
 } finally {rmSync(dir, { recursive: true, force: true })}
})

test('production helper: another ticket and failed generator roll back every fixture byte', () => {
 for (const mode of ['another ticket', 'bad SQL']) {
  const dir = fixture()
  try {
   pending(dir)
   if (mode === 'bad SQL') writeFileSync(join(dir, 'packages/backend/db/product/queries/bad.sql'), '-- name: Bad :one\nSELECT absent FROM reserved;\n')
   const before = bytes(dir)
   const result = invoke(dir, 'node', ['scripts/renumber-migration.mjs', 'packages/backend/db/product/migrations/0009_reserved.sql'], { SMITHERS_MIGRATION_TICKET: mode === 'another ticket' ? 'T-TEST-02' : 'T-TEST-01' })
   assert.notEqual(result.status, 0);assert.match(result.stderr, mode === 'another ticket' ? /another ticket/ : /absent/);assert.deepEqual(bytes(dir), before)
  } finally {rmSync(dir, { recursive: true, force: true })}
 }
})

// Only remote publication is intercepted; Go/sqlc and drift checks execute.
for (const vcs of ['git', 'jj']) for (const defect of ['duplicate', 'gap', 'drift missing', 'drift failure', 'target missing', 'target failure', 'clean']) {
 test(`production commit --push ${vcs}: ${defect}`, () => {
  const dir = fixture();const tools = mkdtempSync(join(tmpdir(), 'prc02-tools-'))
  try {
   const log = join(tools, 'commands.log')
   const realGit = ok(dir, 'which', ['git'])
   const realSmithers = ok(dir, 'which', ['smthrs'])
   writeFileSync(join(tools, 'smthrs'), `#!/bin/sh\nprintf '%s\\n' "smthrs $*" >> '${log}'\nexec '${realSmithers}' "$@"\n`, { mode: 0o755 })
   writeFileSync(join(tools, 'go'), `#!/bin/sh\nprintf '%s\\n' "go $*" >> '${log}'\nexec '${go}' "$@"\n`, { mode: 0o755 })
   // Local VCS mutations use Git. The jj protocol fixture avoids requiring or executing jj.
   writeFileSync(join(tools, 'git'), `#!/bin/sh\nif [ "$1" = push ]; then echo PUSH >> '${log}'; exit 0; fi\nif [ "$1" = fetch ]; then exec '${realGit}' update-ref refs/remotes/origin/main HEAD; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
   if (vcs === 'jj') {
    mkdirSync(join(dir, '.jj'))
    writeFileSync(join(tools, 'jj'), `#!/bin/sh\ncase "$*" in\n *conflicts*) exit 0;;\n 'diff --summary') exit 0;;\n 'git push '*) echo PUSH >> '${log}';;\n 'git fetch '*) exit 0;;\n log*) echo 0123456789abcdef;;\n *) echo unexpected-jj-command >&2; exit 1;;\nesac\n`, { mode: 0o755 })
   }
   if (['duplicate', 'gap'].includes(defect)) pending(dir, defect === 'gap' ? '0003' : '0001', 'installed')
   if (defect === 'drift missing') rmSync(join(dir, 'scripts/check-sqlc-drift.sh'))
   if (defect === 'target missing') writeFileSync(join(dir, 'scripts/PACKAGE.ts'), 'import { Smithers as S } from "@smthrs/targets"; export const Package = S.Package({targets:{conflictMarkers:S.Shell.Diff({shell:"true",changes:[],sandbox:"none"})}})\n')
   if (defect === 'target failure') writeFileSync(join(dir, 'PACKAGE.ts'), readFileSync(join(dir, 'PACKAGE.ts'), 'utf8').replace('shell:"true"', 'shell:"false"'))
   if (defect === 'drift failure') writeFileSync(join(dir, 'packages/backend/internal/db/models.go'), '// stale generated models\n')
   const result = invoke(dir, 'node', ['scripts/commit.mjs', '--push', '--test', 'true'], { PATH: `${tools}:${process.env.PATH}` })
   const commands = readFileSync(log, 'utf8').trim().split('\n')
   assert.equal(commands[0], 'go test -run TestMigrationGate|TestMigrationRegistry ./packages/backend/db/product/')
   if (defect === 'clean') {
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(commands.filter(x => x === 'PUSH').length, 1)
    assert.equal(commands[1], 'go test -count=1 -run ^TestSQLCRegenerationIsClean$ -v packages/backend/internal/db/sqlc_regeneration_test.go')
    assert.equal(commands.at(-2), 'smthrs lint //:driftCi //:targetIndex //:ci //scripts:trackedHygiene //scripts:conflictMarkers')
    assert.equal(commands.at(-1), 'PUSH')
   } else {
    assert.notEqual(result.status, 0);assert.match(result.stdout + result.stderr, defect === 'drift missing' ? /drift gate is unavailable/ : defect === 'drift failure' ? /differs|no committed sqlc/ : defect.startsWith('target ') ? /targets_failed|target.*found|target.*unknown|pattern.*match/i : /duplicate or gap/);assert.equal(commands.filter(x => x === 'PUSH').length, 0)
   }
  } finally {rmSync(dir, { recursive: true, force: true });rmSync(tools, { recursive: true, force: true })}
 })
}


test('helper regeneration precedes mandatory push gates in the same production checkout', () => {
 const dir = fixture();const tools = mkdtempSync(join(tmpdir(), 'prc02-order-'))
 try {
  pending(dir)
  const log = join(tools, 'commands.log')
  const realGit = ok(dir, 'which', ['git'])
  const realSQLC = ok(dir, 'which', ['sqlc'])
  for (const [name, real] of [['go', go], ['sqlc', realSQLC]]) writeFileSync(join(tools, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  writeFileSync(join(tools, 'git'), `#!/bin/sh\nif [ "$1" = push ]; then echo PUSH >> '${log}'; exit 0; fi\nif [ "$1" = fetch ]; then exec '${realGit}' update-ref refs/remotes/origin/main HEAD; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
  const env = { PATH: `${tools}:${process.env.PATH}`, SMITHERS_MIGRATION_TICKET: 'T-TEST-01' }
  ok(dir, 'node', ['scripts/renumber-migration.mjs', 'packages/backend/db/product/migrations/0009_reserved.sql'], env)
  ok(dir, 'node', ['scripts/commit.mjs', '--push', '--test', 'true'], env)
  const commands = readFileSync(log, 'utf8').trim().split('\n')
  assert.deepEqual(commands.slice(0, 6), [
   'sqlc version',
   'go test -count=1 -run TestMigrationGate|TestMigrationRegistry ./packages/backend/db/product/',
   'sqlc generate -f packages/backend/db/product/sqlc.yaml',
   'go test -count=1 -run TestMigrationGate|TestMigrationRegistry ./packages/backend/db/product/',
   'go test -run TestMigrationGate|TestMigrationRegistry ./packages/backend/db/product/',
   'go test -count=1 -run ^TestSQLCRegenerationIsClean$ -v packages/backend/internal/db/sqlc_regeneration_test.go',
  ])
  assert.equal(commands.at(-1), 'PUSH');assert.equal(commands.filter(x => x === 'PUSH').length, 1)
 } finally {rmSync(dir, { recursive: true, force: true });rmSync(tools, { recursive: true, force: true })}
})

test('selected production gate returns nonzero for literal SQL and ownership violations without DB URLs', () => {
 for (const [sql, csv, expected] of [
  ['CREATE TABLE things(id int); CREATE TABLE IF NOT EXISTS things(id int);', 'things,product,installed\n', /duplicate CREATE/],
  ['CREATE TABLE missing(id int);', '', /unowned product table/],
  ['CREATE TABLE things(id int);', 'things,product,planned:T-OTHER-01;owner:smithers-other\n', /another ticket/],
  ['CREATE TABLE things(id int); DROP TABLE things;', 'things,product,installed\n', /dropped table/],
  ['CREATE TABLE things(id int) PARTITION BY RANGE(id); CREATE TABLE child PARTITION OF things FOR VALUES FROM(0) TO(1);', 'child,product,installed\n', /unowned product table things/],
 ]) {
  const dir = fixture()
  try {
   writeFileSync(join(dir, 'packages/backend/db/product/migrations/0001_things.sql'), sql)
   writeFileSync(join(dir, 'packages/backend/db/ownership.csv'), 'table,target_owner,status\n' + csv)
   const result = invoke(dir, go, ['test', '-count=1', '-run', '^TestMigrationGate$', './packages/backend/db/product/'], { SMITHERS_MIGRATION_TICKET: 'T-TEST-01' })
   assert.notEqual(result.status, 0);assert.match(result.stdout + result.stderr, expected)
  } finally {rmSync(dir, { recursive: true, force: true })}
 }
})

test('production helper isolates Go and sqlc from database and publication credentials', () => {
 const dir = fixture();const tools = mkdtempSync(join(tmpdir(), 'prc02-env-'))
 try {
  pending(dir)
  const log = join(tools, 'isolated.log')
  const realSQLC = ok(dir, 'which', ['sqlc'])
  for (const [name, real] of [['go', go], ['sqlc', realSQLC]]) {
   writeFileSync(join(tools, name), `#!/bin/sh\nfor key in DATABASE_URL SMITHERS_TEST_DATABASE_URL PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE GITHUB_TOKEN; do\n if printenv "$key" >/dev/null; then echo "credential inherited: $key" >&2; exit 97; fi\ndone\nprintf '%s\\n' '${name}' >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  }
  // PGSERVICE/PGPASSFILE survive the outer fixture launcher. The production
  // helper, rather than the test harness, must remove them for both generators.
  ok(dir, 'node', ['scripts/renumber-migration.mjs', 'packages/backend/db/product/migrations/0009_reserved.sql'], {
   PATH: `${tools}:${process.env.PATH}`, SMITHERS_MIGRATION_TICKET: 'T-TEST-01',
   PGSERVICE: 'live-service-canary', PGSERVICEFILE: '/live-service-canary', PGPASSFILE: '/live-password-canary',
  })
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['sqlc', 'go', 'sqlc', 'go'])
  assert.match(readFileSync(join(dir, 'packages/backend/internal/db/models.go'), 'utf8'), /type Reserved struct/)
 } finally {rmSync(dir, { recursive: true, force: true });rmSync(tools, { recursive: true, force: true })}
})

test('production helper refuses a live home credential store before repository mutation', () => {
 const dir = fixture()
 try {
  pending(dir)
  const credentials = join(dir, '.git/test-home/.config/issue-claim')
  mkdirSync(credentials, { recursive: true })
  writeFileSync(join(credentials, 'app.json'), '{"canary":"must remain unread"}\n')
  const before = bytes(dir)
  const result = invoke(dir, 'node', ['scripts/renumber-migration.mjs', 'packages/backend/db/product/migrations/0009_reserved.sql'], { SMITHERS_MIGRATION_TICKET: 'T-TEST-01' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /isolated home/)
  assert.deepEqual(bytes(dir), before)
 } finally {rmSync(dir, { recursive: true, force: true })}
})
