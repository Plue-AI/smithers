// Synthetic tool-state writes, never real credentials or tool-login qualification.
const fs = require('node:fs'), { DatabaseSync } = require('node:sqlite');
const [phase, vm] = process.argv.slice(2), home = '/home/ben';
const paths = ['.claude', '.config/gh', '.npm/_cacache'];
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const row = seq => ({vm, seq, payload: `${vm}:${String(seq).padStart(6, '0')}:` + 'x'.repeat(128)});
const atomic = (path, value) => {
  const temp = path + '.' + vm + '.tmp', fd = fs.openSync(temp, 'w', 0o600);
  fs.writeSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(temp, path);
};
const result = {phase, vm, uid: process.getuid(), gid: process.getgid(),
  completed: false, iterations: 0, errors: [], observations: [], shared_reads: [], sqlite: {}};
const error = (path, seq, e) => result.errors.push({path, seq, code: e.code,
  errcode: e.errcode, message: e.message});
const dbs = {};
try {
  if (phase.startsWith('sqlite-')) for (const path of paths) {
    try {
      const db = new DatabaseSync(`${home}/${path}/${phase}.sqlite`);
      db.exec('PRAGMA busy_timeout=10; PRAGMA synchronous=FULL');
      dbs[path] = {db, insert: db.prepare('INSERT INTO writes VALUES (?, ?, ?)')};
      result.sqlite[path] = {journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        succeeded: []};
    } catch (e) { error(path, 0, e); }
  }
  fs.writeFileSync(`${home}/ready-${phase}-${vm}`, 'ready', {mode: 0o600});
  const deadline = performance.now() + 60000;
  while (!fs.existsSync(`${home}/start-${phase}`)) {
    if (performance.now() > deadline) throw new Error('Start barrier timed out');
    pause(5);
  }
  const start = performance.now();
  // Each guest starts from barrier visibility on its own monotonic clock.
  // The 10 ms offset is a target, not evidence of exact physical alternation.
  const scheduledStart = start + 1000;
  if (phase === 'atomic') result.schedule = {clock: 'guest-monotonic-from-barrier',
    period_ms: 20, offset_ms: vm === '2' ? 10 : 0, late_starts: 0, max_lateness_ms: 0};
  for (let seq = 1; seq <= 1000; seq++) {
    if (phase === 'atomic') {
      const target = scheduledStart + (seq - 1) * 20 + result.schedule.offset_ms;
      pause(Math.max(0, target - performance.now()));
      const lateness = performance.now() - target;
      result.schedule.late_starts += lateness > 10 ? 1 : 0;
      result.schedule.max_lateness_ms = Math.max(result.schedule.max_lateness_ms, lateness);
    }
    const value = JSON.stringify(row(seq));
    if (phase === 'atomic') {
      try {
        atomic(`${home}/.spike/vm${vm}-${seq}`, value);
        atomic(`${home}/.spike/shared.json`, value);
        let observed = null, read_error = null;
        try { observed = JSON.parse(fs.readFileSync(`${home}/.spike/shared.json`)); }
        catch (e) { read_error = e.code || e.message; }
        result.shared_reads.push({seq, observed, error: read_error, elapsed_ms: performance.now() - start});
      } catch (e) { error('.spike', seq, e); }
    } else for (const path of paths) {
      try {
        if (phase === 'files') {
          const base = `${home}/${path}`;
          const fd = fs.openSync(`${base}/records/${vm}-${seq}.json`, 'wx', 0o600);
          fs.writeSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd);
          const append = fs.openSync(`${base}/append.jsonl`, 'a', 0o600);
          fs.writeSync(append, value + '\n'); fs.fsyncSync(append); fs.closeSync(append);
          atomic(`${base}/shared.json`, value);
          atomic(`${base}/progress-${vm}.json`, value);
          let peer_seq = null, read_error = null, peer_vm = null, peer_valid = null;
          const other = vm === '1' ? '2' : '1';
          try {
            const peer = JSON.parse(fs.readFileSync(`${base}/progress-${other}.json`));
            peer_seq = peer.seq; peer_vm = peer.vm;
            peer_valid = peer_vm === other && Number.isInteger(peer_seq) && peer_seq >= 1 && peer_seq <= 1000 &&
              peer.payload === `${other}:${String(peer_seq).padStart(6, '0')}:` + 'x'.repeat(128);
          }
          catch (e) { read_error = e.code || e.message; }
          result.observations.push({path, seq, peer_seq, read_error, peer_vm, peer_valid,
            elapsed_ms: performance.now() - start});
        } else if (dbs[path]) {
          dbs[path].insert.run(vm, seq, row(seq).payload);
          result.sqlite[path].succeeded.push(seq);
        }
      } catch (e) { error(path, seq, e); }
    }
    result.iterations = seq;
    if (seq % 250 === 0) console.log(`PROGRESS ${phase} VM${vm} ${seq}/1000`);
    // Both VMs stay awake; jitter encourages overlap instead of serial batches.
    if (phase !== 'atomic') pause(1 + (seq + Number(vm)) % 3);
  }
  result.elapsed_ms = performance.now() - start;
  result.completed = true;
} catch (e) { error('.', result.iterations, e); }
finally {
  for (const [path, {db}] of Object.entries(dbs)) {
    try { db.close(); } catch (e) { error(path, 1001, e); }
  }
  console.log('RESULT ' + JSON.stringify(result));
}
if (!result.completed) process.exitCode = 1;
