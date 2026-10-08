// C-REL-03 installed-command stages. The owner arranges the named workloads
// and the N/N+1/N+1-prime tap releases; this runner never manufactures them.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, capture, save, cli, compare, mainURL } from '../release/host-maintenance-evidence.mjs';

export async function journey(stage, path) {
  const c = await config(path);
  if (stage === 'capture') return save(c, 'D1.json', await capture(c));
  const before = JSON.parse(await readFile(join(c.evidence, 'D1.json'), 'utf8'));
  if (stage === 'refuse-merge' || stage === 'refuse-burst') {
    const result = await cli(c, ['upgrade'], null);
    const literal = stage === 'refuse-merge' ? 'merge in flight' : 'open burst';
    if (result.status === 0 || !(result.stdout + result.stderr).includes(literal)) throw new Error(`missing refusal: ${literal}`);
    return save(c, `${stage}.json`, compare(before, await capture(c)));
  }
  if (stage === 'upgrade') {
    await cli(c, ['upgrade']);
    const after = await capture(c);
    await save(c, 'D2.json', after);
    return save(c, 'upgrade-compare.json', compare(before, after));
  }
  if (stage === 'failed-upgrade') {
    const result = await cli(c, ['upgrade'], null);
    if (result.status === 0) throw new Error('failing release upgraded successfully');
    // Parse the single-quoted argv emitted by the production recovery hint.
    // Never evaluate the hint as shell source.
    const hints = [...(result.stdout + result.stderr).matchAll(/restore with smthrs host restore ('(?:[^']|'\\'')*')/g)];
    if (hints.length !== 1) throw new Error('expected exactly one restore hint');
    const backup = hints[0][1].slice(1, -1).replaceAll("'\\''", "'");
    const marker = (await readFile(join(c.state, '.upgrade-incomplete'), 'utf8')).trim();
    if (marker !== backup) throw new Error('hint differs from durable recovery marker');
    await cli(c, ['stop']);
    await cli(c, ['restore', backup]);
    const after = await capture(c);
    await save(c, 'D3.json', after);
    return save(c, 'restore-compare.json', compare(before, after));
  }
  throw new Error('stage: capture | refuse-merge | refuse-burst | upgrade | failed-upgrade');
}
if (mainURL(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node scripts/journeys/upgrade.mjs <stage> <owner-config.json>');
  else journey(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
