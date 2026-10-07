import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const script = resolve('scripts/lane-prerequisites.sh')
test('lane prerequisites build once, honor a spaced target path and export it', t => {
  const root = mkdtempSync(join(tmpdir(), 'lane-prerequisites-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin'), target = join(root, 'target dir'), calls = join(root, 'calls')
  mkdirSync(bin)
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'cargo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nmkdir -p "$CARGO_TARGET_DIR/release"\nprintf "#!/bin/sh\\n" > "$CARGO_TARGET_DIR/release/smithers-jj-export"\nchmod +x "$CARGO_TARGET_DIR/release/smithers-jj-export"\n', { mode: 0o755 })
  const result = spawnSync('bash', ['-c', 'source "$SCRIPT" && source "$SCRIPT" && printf "%s" "$SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCRIPT: script, CARGO_TARGET_DIR: target, CALLS: calls }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, join(target, 'release/smithers-jj-export'))
  assert.equal(readFileSync(calls, 'utf8'), 'build --locked --release -p smithers-ffi --bin smithers-jj-export\n')
})
test('a failed helper build refuses before tests with a prerequisite error', t => {
  const root = mkdtempSync(join(tmpdir(), 'lane-prerequisites-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(root, 'cargo'), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
  const result = spawnSync('bash', ['-c', 'source "$SCRIPT" && echo tests-started'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SCRIPT: script, CARGO_TARGET_DIR: join(root, 'target') }
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PREREQUISITE ERROR: could not build/)
  assert.doesNotMatch(result.stdout, /tests-started/)
})
