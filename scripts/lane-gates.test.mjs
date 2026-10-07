/** Regression fixtures for the shared pre-push gate. @since 0.1.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
const script = resolve('scripts/lane-gates.sh');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-gates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
for (const [label, output, baseline, allowed] of [
  ['new node failure', '✖ some test (1.2ms)', 'flows: tool-failure', false],
  ['known node failure', '✖ some test (1.2ms)', 'some test', true],
  ['new TAP failure', 'not ok 1 - some test', 'flows: tool-failure', false],
  ['known TAP failure', 'not ok 1 - some test', 'some test', true],
  ['tool failure', 'Error: compiler unavailable', 'flows: tool-failure', true],
  ['names and tool error', '✖ some test\nError: compiler unavailable', 'flows: tool-failure', false],
  ['passed names and tool error', '✔ some test\nError: compiler unavailable', 'flows: tool-failure', false],
  ['unnamed failures', '# tests 3\n# fail 1', 'flows: tool-failure', false],
  ['Go', '    --- FAIL: TestX/sub (0.01s)', 'TestX/sub', true],
  ['bun', '(fail) some test [1.20ms]', 'some test', true],
  ['vitest FAIL', ' FAIL  some test', 'some test', true],
  ['vitest cross', ' × some test', 'some test', true],
  ['ANSI node', '\x1b[31m✖ some test (1ms)\x1b[0m', 'some test', true],
  ['missing tool baseline', 'Error: compiler unavailable', 'other test', false]
]) test(label, t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'output'), output);
  writeFileSync(join(dir, 'baseline'), baseline + '\n');
  const result = spawnSync('bash', ['-c', `source "$1"
mode=gate; log="$2/log"; baseline="$2/baseline"; newreds=()
check flows 'cat "$FIXTURE/output"; exit 1'
[ \${#newreds[@]} -eq 0 ]`, '_', script, dir], {
    encoding: 'utf8', env: { ...process.env, FIXTURE: dir }
  });
  assert.equal(result.status, allowed ? 0 : 1, result.stderr);
});
for (const behavior of ['drop', 'keep', 'delete', 'allow-delete', 'wrong-allowance']) test(`integration ${behavior}`, t => {
  const dir = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(dir, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'file.txt'), 'base\nmain added\n'); git('commit', '-qam', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', '--detach', base);
  if (behavior.includes('delete') || behavior === 'wrong-allowance') git('rm', '-q', 'file.txt');
  else writeFileSync(join(dir, 'file.txt'), behavior === 'keep' ? 'base\nmain added\nlane\n' : 'base\nlane\n');
  git('add', '.'); git('commit', '-qm', 'lane');
  const args = ['--integration', base];
  if (behavior === 'allow-delete') args.push('--allow-deleted', '*.txt');
  if (behavior === 'wrong-allowance') args.push('--allow-deleted', '*.tsx');
  const result = spawnSync('bash', [script, ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, ['keep', 'allow-delete'].includes(behavior) ? 0 : 1, result.stderr);
  if (result.status === 1) assert.match(result.stdout, /file\.txt\t1/);
});

for (const reporter of ['spec', 'tap']) test(`real node:test ${reporter}`, t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'red.test.mjs'), "import {test} from 'node:test'; test('some test', () => { throw new Error('red'); });");
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, join(dir, 'red.test.mjs')], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  const parsed = spawnSync('bash', ['-c', 'source "$1"; extract', '_', script], { input: run.stdout, encoding: 'utf8' });
  assert.match(parsed.stdout, /^some test$/m);
});

test('baseline without baseline-run marker is refused before touching host state', () => {
  const env = { ...process.env, LANE: 'l22-gate' };
  const result = spawnSync('bash', [script, '--baseline'], { encoding: 'utf8', env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /REFUSED: only .*baseline-run.sh/);
});
