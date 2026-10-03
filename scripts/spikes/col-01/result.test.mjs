import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [name, content] of [['missing', undefined], ['invalid', '{'], ['incomplete', '{}']]) {
  test(`requested snapshot ${name} fails with retained reason`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'col01-result-'));
    try {
      if (content !== undefined) await writeFile(join(dir, 'snapshot-summary.json'), content);
      const result = spawnSync(process.execPath, ['scripts/spikes/col-01/result.mjs', dir, dir, dir, 'snapshot'], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stdout, /Incomplete requested measurements/);
      assert.match(result.stdout, /snapshot/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
test('explicit snapshot-only mode does not require RTT or browsers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'col01-result-'));
  try {
    const cells = ['idle', 'busy'].flatMap(load => [0, 1, 12, 200].map(changed_files => ({ load, changed_files, stats: { n: 100, p50_ns: 1, p95_ns: 2, p99_ns: 3 } })));
    await writeFile(join(dir, 'snapshot-summary.json'), JSON.stringify({ cells, idle_12_file_gate_passed: true }));
    const result = spawnSync(process.execPath, ['scripts/spikes/col-01/result.mjs', dir, dir, dir, 'snapshot'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Incomplete requested measurements/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('combined report rejects absent RTT, controls and browser runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'col01-result-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/spikes/col-01/result.mjs', dir, dir], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /summary.json/);
    assert.match(result.stdout, /control-summary.json/);
    assert.match(result.stdout, /browser.*expected 3/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
