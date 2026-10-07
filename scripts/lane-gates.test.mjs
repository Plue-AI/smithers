/** Regression fixtures for the shared pre-push gate. @since 0.1.0 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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
  ['vitest timed cross', ' × some test 124ms', 'some test', true],
  ['vitest decimal duration', ' × some test 1.25s', 'some test', true],
  ['vitest new timed failure', ' × new test 124ms', 'some test', false],
  ['timed baseline milliseconds', ' × some test 124ms', 'some test 5312ms', true],
  ['timed baseline seconds', ' × some test 1.25s', 'some test 2.75s', true],
  ['timed baseline parentheses', '✖ some test (1.2ms)', 'some test (4ms)', true],
  ['timed baseline does not admit new names', ' × other test 124ms', 'some test 5312ms', false],
  ['timed baseline mixed names', ' × first test 1ms\n × second test 2ms', 'first test 13ms\nsecond test 2.5s', true],
  ['duration inside a name stays significant', ' × takes 10ms for input 1ms', 'takes 11ms for input 13ms', false],
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
  assert.equal(readFileSync(join(dir, 'baseline'), 'utf8'), baseline + '\n');
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

test('baseline writes require the baseline-run marker', () => {
  assert.match(readFileSync(script, 'utf8'), /\[ \$mode = baseline \] && \[ "\$\{LANE:-\}" != fr-baseline-main \]/);
});

test('Go selection includes transitive importers and prints the selected list', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'go.mod'), 'module fixture.local/reverse\n\ngo 1.24\n');
  for (const [pkg, body] of Object.entries({a: 'const A = 1', b: 'import "fixture.local/reverse/a"\nconst B = a.A', c: 'const C = 1', d: 'import "fixture.local/reverse/b"\nconst D = b.B'})) {
    mkdirSync(join(dir, pkg));
    writeFileSync(join(dir, pkg, 'code.go'), `package ${pkg}\n${body}\n`);
  }
  for (const [touched, expected] of [
    ['./a', ['a', 'b', 'd']],
    ['./a ./c', ['a', 'b', 'c', 'd']],
    ['./a ./b ./c', ['a', 'b', 'c', 'd']]
  ]) {
    const result = spawnSync('bash', ['-c', 'source "$1"; log="$2/log"; : > "$log"; select_go_packages "$2" "$3" >/dev/null || exit; cat "$log"', '_', script, dir, touched], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Selected Go packages/);
    assert.deepEqual(result.stdout.trim().split('\n').slice(1), expected.map(pkg => `fixture.local/reverse/${pkg}`));
  }
  const empty = spawnSync('bash', ['-c', 'source "$1"; log="$2/log"; select_go_packages "$2" fmt', '_', script, dir], {encoding: 'utf8'});
  assert.equal(empty.status, 1, empty.stderr);
  assert.match(empty.stderr, /No Go packages selected/);
});

test('unformatted Go in a touched package is refused even with a tool baseline', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'bad.go'), 'package bad\nfunc Bad( ){ }\n');
  const result = spawnSync('bash', ['-c', 'source "$1"; log="$2/log"; newreds=(); check_go_format "$2"; status=$?; cat "$log"; exit "$status"', '_', script, dir], {encoding: 'utf8'});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL gofmt:/);
  assert.match(result.stdout, /bad\.go/);
});


test('an unreadable baseline cannot admit a named failure', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'output'), ' × some test 1ms');
  const result = spawnSync('bash', ['-c', `source "$1"
mode=gate; log="$2/log"; baseline="$2/missing"; newreds=()
check flows 'cat "$FIXTURE/output"; exit 1'
[ \${#newreds[@]} -eq 0 ]`, '_', script, dir], {
    encoding: 'utf8', env: { ...process.env, FIXTURE: dir }
  });
  assert.equal(result.status, 1);
  assert.match(readFileSync(join(dir, 'log'), 'utf8'), /unreadable baseline/);
});
