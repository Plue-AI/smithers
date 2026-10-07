import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function followup(dir) {
  await writeFile(join(dir, 'growth-summary.json'), JSON.stringify({ uid: 19999, captures: 1000, versions: { n: 100, p50_ns: 1, p95_ns: 2, p99_ns: 3 }, projected_14_day_bytes: 1000, growth_budget_passed: true, reclaimed_bytes: 42, retention_acceptance: "measured" }));
  const cycles = Array.from({ length: 3 }, (_, i) => ({ captures: 5760, start_epoch: i * 86400, end_epoch: i * 86400 + 28800, before: { '.jj': 0, '.git': 0 }, after: { '.jj': 1000, '.git': 0 }, after_gc: { '.jj': 100, '.git': 0 } }));
  await writeFile(join(dir, 'retention-cycles.json'), JSON.stringify(cycles));
  await writeFile(join(dir, 'retention-samples.csv'), 'cycle,capture,epoch,snapshot_ns,jj_bytes,git_bytes\n' + cycles.flatMap((c, i) => Array.from({ length: 5760 }, (_, j) => `${i + 1},${j + 1},${c.start_epoch + j * 5 + 1},1,1000,0`)).join('\n') + '\n');
  for (let i = 1; i <= 3; i++) for (const suffix of ['operations.tsv', 'abandon.log', 'gc.log']) await writeFile(join(dir, `cycle-${i}-${suffix}`), 'fixture receipt');
  await writeFile(join(dir, 'kernel-probes.json'), JSON.stringify({ uid: 19999, complete: true, probes: Object.fromEntries(['renameat2_exchange', 'renameat2_noreplace', 'openat2_beneath', 'cgroup.freeze', 'cgroup.kill'].map(name => [name, { yes: false }])) }));
  for (const [file, count] of [['growth-samples.csv', 1000], ['versions-samples.csv', 100]]) {
    await writeFile(join(dir, file), 'seq,value\n' + Array.from({ length: count }, (_, i) => `${i + 1},1`).join('\n') + '\n');
  }
  for (const file of ['growth-abandon.log', 'growth-gc.log']) await writeFile(join(dir, file), '');
}
async function snapshot(dir) {
  const cells = ['idle', 'busy'].flatMap(load => [0, 1, 12, 200].map(changed_files => ({ load, changed_files, stats: { n: 100, p50_ns: 1, p95_ns: 2, p99_ns: 3 } })));
  await writeFile(join(dir, 'snapshot-summary.json'), JSON.stringify({ cells, idle_12_file_gate_passed: true }));
}

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
    await snapshot(dir);
    await followup(dir);
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

for (const [name, n, verified, status] of [['complete', 100, true, 0], ['short', 99, true, 2], ['unverified', 100, false, 2]]) {
  test(`control-only report ${name} requires both verified 100-write baselines`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'col01-result-'));
    try {
      for (const baseline of ['control', 'one-exec-control']) {
        await writeFile(join(dir, `${baseline}-summary.json`), JSON.stringify({ n, all_readbacks_verified: verified, p50_ns: 1, p95_ns: 2, p99_ns: 3 }));
      }
      const result = spawnSync(process.execPath, ['scripts/spikes/col-01/result.mjs', dir, dir, dir, 'control'], { encoding: 'utf8' });
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stdout, /control writes/);
      if (status) assert.match(result.stdout, /expected 100 verified writes/);
      else assert.doesNotMatch(result.stdout, /Incomplete requested measurements/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ['missing', 'blocked', 'short', 'budget', 'stale-gate', 'missing-cycles', 'burst-cycles', 'short-cycles']) {
  test(`snapshot report rejects ${scenario} follow-up evidence`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'col11-result-'));
    try {
      await snapshot(dir);
      if (scenario !== 'missing') await followup(dir);
      if (scenario === 'blocked') await writeFile(join(dir, 'kernel-probes.json'), JSON.stringify({ uid: 19999, complete: false, probes: { 'cgroup.kill': { status: 'blocked' } } }));
      if (scenario === 'short') await writeFile(join(dir, 'growth-samples.csv'), 'seq,value\n1,1\n');
      if (scenario === 'budget' || scenario === 'stale-gate') await writeFile(join(dir, 'growth-summary.json'), JSON.stringify({ uid: 19999, captures: 1000, versions: { n: 100, p95_ns: 2 }, projected_14_day_bytes: 2147483648, growth_budget_passed: scenario === 'stale-gate' }));
      if (scenario === 'missing-cycles') await rm(join(dir, 'retention-cycles.json'));
      if (scenario === 'burst-cycles') {
        const path = join(dir, 'retention-samples.csv');
        const rows = (await readFile(path, 'utf8')).split('\n');
        rows[2] = '1,2,1,1,1000,0';
        await writeFile(path, rows.join('\n'));
      }
      if (scenario === 'short-cycles') await writeFile(join(dir, 'retention-samples.csv'), 'cycle,capture,epoch,snapshot_ns,jj_bytes,git_bytes\n1,1,0,1,1000,0\n');
      const result = spawnSync(process.execPath, ['scripts/spikes/col-01/result.mjs', dir, dir, dir, 'snapshot'], { encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stdout, /growth|kernel/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
