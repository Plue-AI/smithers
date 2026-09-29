import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const pacer = fileURLToPath(new URL('./pacer.mjs', import.meta.url));
const loop = fileURLToPath(new URL('./burndown.sh', import.meta.url));
const base = { now: 1000, resetAt: 2000, remaining: 1000, usagePerJob: 10, jobSeconds: 100, machine: { cpu: 32, memoryMb: 65536 } };
const run = input => spawnSync(process.execPath, [pacer], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
function output(input) { const r = run(input); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); }
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'burndown-test-'));
  const input = join(dir, 'input.json'); writeFileSync(input, JSON.stringify(base));
  try { fn({ dir, input, invoke: args => spawnSync('sh', [loop, input, ...args], { encoding: 'utf8', timeout: 30000 }) }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
test('offline quota pacing returns the documented plan', () => {
  assert.deepEqual(output(base), { concurrency: 10, usagePerJob: 10, machineLimit: 31, quotaLimit: 10 });
});
test('quota, machine, and explicit caps independently bind', () => {
  for (const maxConcurrency of [0, 3]) assert.equal(output({ ...base, maxConcurrency }).concurrency, maxConcurrency);
  assert.equal(output({ ...base, remaining: 100000 }).concurrency, 24);
  assert.deepEqual(output({ ...base, machine: { cpu: 7.9, memoryMb: 5000, reserveCpu: 1, reserveMemoryMb: 1000, cpuPerJob: 2, memoryPerJobMb: 1500 } }), { concurrency: 2, usagePerJob: 10, machineLimit: 2, quotaLimit: 10 });
  assert.equal(output({ ...base, machine: { cpu: 0, memoryMb: 0 } }).concurrency, 0);
  assert.equal(output({ ...base, machine: { cpu: 1, memoryMb: 1024 } }).machineLimit, 0);
  assert.equal(output({ ...base, machine: { cpu: 2, memoryMb: 50000 } }).machineLimit, 1);
});
test('fractional pacing floors, total quota cap, and expired windows', () => {
  assert.equal(output({ ...base, remaining: 199 }).quotaLimit, 1);
  assert.equal(output({ ...base, remaining: 19, jobSeconds: 10000 }).quotaLimit, 1);
  for (const remaining of [0, 9]) assert.equal(output({ ...base, remaining }).concurrency, 0);
  for (const resetAt of [1000, 999]) assert.equal(output({ ...base, resetAt }).quotaLimit, 0);
});
test('EWMA folds samples in order with default and explicit alpha', () => {
  assert.equal(output({ ...base, samples: [20, 0] }).usagePerJob, 9.1);
  assert.ok(Math.abs(output({ ...base, samples: [0, 20] }).usagePerJob - 10.9) < 1e-12);
  assert.equal(output({ ...base, samples: [] }).usagePerJob, 10);
  assert.equal(output({ ...base, samples: [20, 4], alpha: 0.5 }).usagePerJob, 9.5);
  assert.equal(output({ ...base, samples: [20, 4], alpha: 1 }).usagePerJob, 4);
  assert.deepEqual(output({ ...base, samples: [0], alpha: 1 }), { concurrency: 0, usagePerJob: 0, machineLimit: 31, quotaLimit: 0 });
});
test('invalid inputs fail with diagnostics and no plan', () => {
  const invalid = ['{', '', 'null', '[]', '{}'];
  for (const field of ['now', 'resetAt', 'remaining', 'usagePerJob', 'jobSeconds']) {
    for (const value of [null, '1', true]) invalid.push({ ...base, [field]: value });
    const missing = { ...base }; delete missing[field]; invalid.push(missing);
  }
  for (const [field, values] of Object.entries({ remaining: [-1], usagePerJob: [0, -1], jobSeconds: [0, -1], alpha: [0, -1, 1.1, null, '0.3'], maxConcurrency: [-1, 1.5, null, '1'], samples: [null, {}, [null], [-1], ['2']] })) {
    for (const value of values) invalid.push({ ...base, [field]: value });
  }
  invalid.push({ ...base, machine: null }, { ...base, machine: {} });
  for (const field of ['cpu', 'memoryMb', 'reserveCpu', 'reserveMemoryMb', 'cpuPerJob', 'memoryPerJobMb']) {
    for (const value of [-1, null, '1']) invalid.push({ ...base, machine: { ...base.machine, [field]: value } });
    if (['cpuPerJob', 'memoryPerJobMb'].includes(field)) invalid.push({ ...base, machine: { ...base.machine, [field]: 0 } });
  }
  for (const field of ['now', 'resetAt', 'remaining', 'usagePerJob', 'jobSeconds', 'alpha', 'maxConcurrency']) {
    invalid.push(JSON.stringify({ ...base, [field]: 'NONFINITE' }).replace('\"NONFINITE\"', '1e999'));
  }
  for (const field of ['cpu', 'memoryMb', 'reserveCpu', 'reserveMemoryMb', 'cpuPerJob', 'memoryPerJobMb']) {
    invalid.push(JSON.stringify({ ...base, machine: { ...base.machine, [field]: 'NONFINITE' } }).replace('\"NONFINITE\"', '1e999'));
  }
  invalid.push(JSON.stringify({ ...base, samples: ['NONFINITE'] }).replace('\"NONFINITE\"', '1e999'));
  invalid.push({ ...base, now: -1 }, { ...base, resetAt: -1 });
  for (const input of invalid) { const r = run(input); assert.notEqual(r.status, 0, JSON.stringify(input)); assert.equal(r.stdout.trim(), ''); assert.ok(r.stderr.trim()); }
});
test('loop defaults to one dry tick and emits one JSON plan each tick', () => fixture(({ invoke }) => {
  for (const args of [[], ['3', '0'], ['003', '000']]) {
    const r = invoke(args); assert.equal(r.status, 0, r.stderr);
    const plans = r.stdout.trim().split('\n').map(JSON.parse); assert.equal(plans.length, args.length ? 3 : 1);
    for (const plan of plans) assert.deepEqual(plan, output(base));
  }
}));
test('command runs once per tick with concurrency and preserves arguments', () => fixture(({ invoke, dir }) => {
  const receipt = join(dir, 'calls');
  const script = 'require("node:fs").appendFileSync(process.argv[1], process.env.BURNDOWN_CONCURRENCY + ":" + process.argv[2] + "\\n")';
  const r = invoke(['2', '0', '--', process.execPath, '-e', script, receipt, 'two words']);
  assert.equal(r.status, 0, r.stderr); assert.equal(readFileSync(receipt, 'utf8'), '10:two words\n10:two words\n');
  assert.equal(r.stdout.trim().split('\n').length, 2);
}));
test('zero concurrency skips explicit commands', () => fixture(({ invoke, input, dir }) => {
  writeFileSync(input, JSON.stringify({ ...base, remaining: 0 })); const receipt = join(dir, 'called');
  const r = invoke(['2', '0', '--', 'touch', receipt]); assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(receipt), false); assert.equal(r.stdout.trim().split('\n').length, 2);
}));
test('loop aborts invalid arguments, malformed input, and failed command', () => fixture(({ invoke, input }) => {
  for (const args of [['0', '0'], ['-1', '0'], ['1.5', '0'], ['NaN', '0'], ['1', '-1'], ['1', 'Infinity'], ['1', 'NaN'], ['1', '0', '--']]) {
    const r = invoke(args); assert.notEqual(r.status, 0, args.join(' ')); assert.equal(r.stdout.trim(), ''); assert.ok(r.stderr.trim());
  }
  const failed = invoke(['3', '0', '--', 'sh', '-c', 'exit 7']); assert.notEqual(failed.status, 0); assert.equal(failed.stdout.trim().split('\n').length, 1);
  writeFileSync(input, '{'); const malformed = invoke(['3', '0']); assert.notEqual(malformed.status, 0); assert.equal(malformed.stdout.trim(), '');
  rmSync(input); assert.notEqual(invoke([]).status, 0);
}));

test('fractional timestamps are accepted and overflow capacities saturate safely', () => {
  assert.equal(output({ ...base, now: 1000.25, resetAt: 2000.25 }).quotaLimit, 10);
  const plan = output({ ...base, remaining: 1e308, usagePerJob: 1e-308, machine: { cpu: 1e308, memoryMb: 1e308, reserveCpu: 0, reserveMemoryMb: 0, cpuPerJob: 1e-308, memoryPerJobMb: 1e-308 } });
  assert.deepEqual(plan, { concurrency: 24, usagePerJob: 1e-308, machineLimit: Number.MAX_SAFE_INTEGER, quotaLimit: Number.MAX_SAFE_INTEGER });
  const extreme = { ...base, now: 0, resetAt: 1e308, remaining: 1e308, usagePerJob: 1e-308, jobSeconds: 5e-324 };
  const recovered = output(extreme);
  assert.equal(recovered.quotaLimit, 0);
  assert.equal(recovered.concurrency, 0);
  for (const field of ['concurrency', 'machineLimit', 'quotaLimit']) assert.ok(Number.isSafeInteger(recovered[field]));
  assert.equal(output({ ...extreme, remaining: 0 }).quotaLimit, 0);
});
test('pacer rejects CLI arguments', () => {
  const r = spawnSync(process.execPath, [pacer, 'unexpected'], { input: JSON.stringify(base), encoding: 'utf8', timeout: 5000 });
  assert.notEqual(r.status, 0); assert.equal(r.stdout.trim(), ''); assert.ok(r.stderr.trim());
});
test('loop rereads live input and skips execution after quota is consumed', () => fixture(({ invoke, input, dir }) => {
  const receipt = join(dir, 'calls');
  const script = 'const fs=require("node:fs");fs.appendFileSync(process.argv[2],"called\\n");const p=process.argv[1];const input=JSON.parse(fs.readFileSync(p));input.remaining=0;fs.writeFileSync(p,JSON.stringify(input));';
  const r = invoke(['2', '0', '--', process.execPath, '-e', script, input, receipt]);
  assert.equal(r.status, 0, r.stderr); assert.equal(readFileSync(receipt, 'utf8'), 'called\n');
  const plans = r.stdout.trim().split('\n').map(JSON.parse); assert.equal(plans.length, 2);
  assert.equal(plans[0].concurrency, 10); assert.equal(plans[1].concurrency, 0);
}));
