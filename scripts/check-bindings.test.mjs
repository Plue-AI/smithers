import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindingErrors } from './check-bindings.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
test('repository check bindings resolve to real files and test declarations', () => {
  const inventory = JSON.parse(readFileSync(resolve(root, 'scripts/check-commands.json'), 'utf8'))
  assert.deepEqual(bindingErrors(inventory, root), [])
})

test('rejects missing files, invented test names, empty selections and stale absence claims', (t) => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'check-bindings-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  mkdirSync(resolve(fixture, 'scripts'))
  writeFileSync(resolve(fixture, 'scripts/bound_test.go'), 'func TestReal(t *testing.T) {}\n')
  writeFileSync(resolve(fixture, 'scripts/bound.test.mjs'), "// test name in a comment: invented\ntest('real case', () => {});\n")
  const command = { argv: ['go', 'test', './scripts', '-run', '^TestReal$'], files: ['scripts/bound_test.go'], reporter: 'go', expectedCaseIds: ['TestReal'] }
  const inventory = (entry) => ({ checks: { 'C-FIXTURE': entry } })
  assert.deepEqual(bindingErrors(inventory({ pendingBinding: { commands: [command] } }), fixture), [])
  for (const [entry, message] of [
    [{ pendingBinding: { subcases: { nested: { files: ['scripts/missing.go'] } } } }, /missing file/],
    [{ pendingBinding: { commands: [{ ...command, expectedCaseIds: ['TestInvented'] }] } }, /missing test/],
    [{ pendingBinding: { commands: [{ ...command, argv: ['go', 'test', './scripts', '-run', '^TestGone$'] }] } }, /matches no declared test/],
    [{ pendingBinding: { commands: [{ ...command, argv: ['bun', 'test', 'scripts/gone.test.ts'] }] } }, /missing argv file/],
    [{ pendingBinding: { commands: [{ argv: ['node', '--test', 'scripts/bound.test.mjs'], files: ['scripts/bound.test.mjs'], reporter: 'node', expectedCaseIds: ['invented'] }] } }, /missing test/],
    [{ pendingBinding: { commands: [{ ...command, cwd: 'missing-directory' }] } }, /missing cwd/],
    [{ reason: 'Person required; Absent: scripts/bound_test.go, scripts/missing.go' }, /Absent reason names existing file/],
  ]) assert.match(bindingErrors(inventory(entry), fixture).join('\n'), message)
  assert.deepEqual(bindingErrors(inventory({ reason: 'Absent: scripts/missing.go' }), fixture), [])
})
