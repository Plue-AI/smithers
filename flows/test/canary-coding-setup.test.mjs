import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import * as Discovery from '@smthrs/registry/Discovery'
import { Effect, Layer } from 'effect'

/** The registry's own scan of an installed canary repository. */
const scan = root =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* (yield* Discovery.Discovery).scan({ source: 'project', root: join(root, 'flows'), naming: 'path' })
    }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(NodeServices.layer))))
  )

test('canary setup installs only documentation checks and the project file, never coding code', { timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'canary-coding-setup-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const output = join(temporary, 'artifact'), root = join(temporary, 'repo')
  execFileSync(process.execPath, [fileURLToPath(new URL('./canary-coding-setup.mjs', import.meta.url)), output], { stdio: 'pipe' })
  await mkdir(root)
  const initial = '# canary-sandbox\n\nSmithers Cloud canary fixture repo.\n'
  await writeFile(join(root, 'README.md'), initial)
  execFileSync('bash', [join(output, 'setup.sh')], { cwd: root, stdio: 'pipe' })
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), initial, 'setup never edits the task file')
  // The host serves every coding route as a built-in, so setup installs no
  // coding code: the registry finds only the three checks.
  assert.equal(existsSync(join(root, 'flows/coding')), false, 'setup vendors no coding bundles')
  const found = await scan(root)
  assert.deepEqual(found.entries.map(entry => [entry.name, [...entry.flows]]), [
    ['checks/fast', ['coding/CommandCheck']],
    ['checks/slow', ['coding/CommandCheck']],
    ['checks/wiki', ['coding/WikiCheck']]
  ])
  assert.deepEqual(found.warnings, [])
  const check = tier => spawnSync('python3', [join(output, tier + '.py')], { cwd: root, encoding: 'utf8' })
  assert.notEqual(check('fast').status, 0, 'unchanged fixture must fail the new task requirement')
  await writeFile(join(root, 'README.md'), initial + '\n## Purpose\n\nA disposable fixture for production testing of Smithers.\n')
  assert.equal(check('fast').status, 0)
  assert.equal(check('slow').status, 0)
  await writeFile(join(root, 'README.md'), initial + '\n[Broken link](missing.md)\n')
  assert.notEqual(check('slow').status, 0, 'broken source links must fail')
  await writeFile(join(root, 'flows/checks/fast/flow.mdx'), 'existing user flow')
  const retry = spawnSync('bash', [join(output, 'setup.sh')], { cwd: root, encoding: 'utf8' })
  assert.notEqual(retry.status, 0, 'setup cannot replace different existing flow source')
  assert.equal(await readFile(join(root, 'flows/checks/fast/flow.mdx'), 'utf8'), 'existing user flow')
})
