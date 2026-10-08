// C-REL-06 local stages: backup on A, copy while A is stopped, restore on B.
// Each stage records actual installed-command output. Missing Mac/provider
// evidence is a failure, never a fabricated successful receipt.
import { readFile, lstat, readdir, mkdir, unlink, open, statfs } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, run, capture, save, cli, compare, inventory, hostProfile, verifyBackup, mainURL } from './host-maintenance-evidence.mjs';

export async function backupRestore(stage, path, backup) {
  const c = await config(path);
  if (stage === 'backup') {
    let ended = false;
    const began = Date.now();
    const pending = cli(c, ['backup']).finally(() => { ended = true; });
    pending.catch(() => {});
    let before;
    while (!ended && Date.now() - began < 120_000) {
      const output = await run(c.psql, ['-X', '-qAt', '-c', "SELECT COALESCE((SELECT value::text FROM install_settings WHERE key='quiesce'), 'null')"], { env: { PGDATABASE: c.database, PGOPTIONS: '-c default_transaction_read_only=on' } });
      const freeze = JSON.parse(output.stdout);
      if (freeze?.ready && freeze.op.startsWith('backup-') && Date.parse(freeze.since) >= began) {
        before = await capture(c);
        const observed = await run(c.psql, ['-X', '-qAt', '-c', "SELECT COALESCE((SELECT value::text FROM install_settings WHERE key='quiesce'), 'null')"], { env: { PGDATABASE: c.database, PGOPTIONS: '-c default_transaction_read_only=on' } });
        const stillFrozen = JSON.parse(observed.stdout);
        if (!stillFrozen?.ready || stillFrozen.op !== freeze.op || Date.parse(stillFrozen.lease_until) <= Date.now()) throw new Error('freeze ended during independent capture');
        break;
      }
      await sleep(10);
    }
    const result = await pending;
    if (!before) throw new Error('ready freeze not observed; no independent snapshot receipt');
    await save(c, 'host-a.json', before);
    const directory = result.stdout.trim();
    if (!isAbsolute(directory) || !directory.startsWith(c.state + '/backups/')) throw new Error('backup did not print a STATE backup directory');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new Error('backup directory must be 0700');
    const verified = await verifyBackup(directory);
    await save(c, 'MANIFEST.json', verified.manifest);
    await save(c, 'backup-tree.json', await inventory(directory));
    await cli(c, ['stop']);
    return save(c, 'host-a-stopped.json', { at: new Date().toISOString(), directory });
  }
  if (stage === 'restore') {
    if (!backup || !isAbsolute(backup)) throw new Error('absolute transferred backup directory required');
    // The A-stopped receipt must accompany the archive before B starts.
    const stopped = JSON.parse(await readFile(join(c.evidence, 'host-a-stopped.json'), 'utf8'));
    if (!stopped.at || !stopped.directory) throw new Error('missing A shutdown receipt');
    const before = JSON.parse(await readFile(join(c.evidence, 'host-a.json'), 'utf8'));
    const profile = await hostProfile(c);
    if (before.profile.uuid === profile.uuid || before.profile.state === profile.state || before.profile.user === profile.user) throw new Error('requires second Mac with a different fresh owner account');
    await verifyBackup(backup);
    await cli(c, ['restore', backup]);
    const after = await capture(c);
    await save(c, 'host-b.json', after);
    return save(c, 'restore-compare.json', compare(before, after));
  }
  if (stage === 'refuse-incomplete' || stage === 'refuse-hash') {
    if (!backup || !isAbsolute(backup)) throw new Error('absolute complete backup required');
    await verifyBackup(backup);
    const before = await capture(c);
    const parent = join(c.evidence, `corrupt-${stage}-${Date.now()}`);
    await mkdir(parent, { mode: 0o700 });
    const bad = join(parent, basename(backup));
    // Clone into evidence, never alter the owner's original backup.
    await run('/bin/cp', ['-cR', backup, bad]);
    if (stage === 'refuse-incomplete') await unlink(join(bad, 'MANIFEST.json'));
    else {
      const dump = await open(join(bad, 'postgres.dump'), 'r+');
      try {
        const byte = Buffer.alloc(1);
        if ((await dump.read(byte, 0, 1, 0)).bytesRead !== 1) throw new Error('dump empty');
        byte[0] ^= 1;
        await dump.write(byte, 0, 1, 0);
        await dump.sync();
      } finally { await dump.close(); }
    }
    const result = await cli(c, ['restore', bad], null);
    const literal = stage === 'refuse-incomplete' ? 'missing_file: MANIFEST.json' : 'hash_mismatch: postgres.dump';
    if (result.status === 0 || !(result.stdout + result.stderr).includes(literal)) throw new Error(`missing refusal: ${literal}`);
    return save(c, `${stage}.json`, compare(before, await capture(c)));
  }
  if (stage === 'refuse-space') {
    const volume = await statfs(c.state, { bigint: true });
    const size = await run(c.psql, ['-X', '-qAt', '-c', 'SELECT pg_database_size(current_database())'], { env: { PGDATABASE: c.database, PGOPTIONS: '-c default_transaction_read_only=on' } });
    const free = volume.bavail * volume.bsize;
    const database = BigInt(size.stdout.trim());
    if (free >= (40n << 30n) && free - (40n << 30n) >= database) throw new Error('owner must prepare the low-space volume; recorder does not fill it');
    const before = await capture(c);
    const result = await cli(c, ['backup'], null);
    if (result.status === 0 || !(result.stdout + result.stderr).includes('insufficient_space:')) throw new Error('missing free-space refusal');
    return save(c, 'refuse-space.json', { ...compare(before, await capture(c)), free: free.toString(), database: database.toString() });
  }
  if (stage === 'retention') {
    const created = [];
    for (let i = 0; i < 4; i++) {
      const result = await cli(c, ['backup']);
      const directory = result.stdout.trim();
      const verified = await verifyBackup(directory);
      created.push({ directory, time: verified.manifest.quiesce_time });
    }
    const remaining = [];
    for (const name of await readdir(join(c.state, 'backups'))) {
      if (name.startsWith('.partial-') || name.startsWith('pre-restore-')) continue;
      const directory = join(c.state, 'backups', name);
      const stat = await lstat(directory);
      if (!stat.isDirectory()) continue;
      const verified = await verifyBackup(directory);
      remaining.push({ directory, time: verified.manifest.quiesce_time });
    }
    const newest = created.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 3).map(item => item.directory).sort();
    if (JSON.stringify(remaining.map(item => item.directory).sort()) !== JSON.stringify(newest)) throw new Error('retention did not keep exactly the newest three backups');
    return save(c, 'retention.json', { created, remaining, pass: true });
  }
  throw new Error('stage: backup | restore | refuse-incomplete | refuse-hash | refuse-space | retention');
}
if (mainURL(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node scripts/release/backup-restore.mjs <stage> <owner-config.json> [transferred-backup]');
  else backupRestore(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
