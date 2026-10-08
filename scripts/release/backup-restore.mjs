// C-REL-06 local stages: backup on A, copy while A is stopped, restore on B.
// Each stage records actual installed-command output. Missing Mac/provider
// evidence is a failure, never a fabricated successful receipt.
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
  throw new Error('stage: backup | restore');
}
if (mainURL(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node scripts/release/backup-restore.mjs <backup|restore> <owner-config.json> [transferred-backup]');
  else backupRestore(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
