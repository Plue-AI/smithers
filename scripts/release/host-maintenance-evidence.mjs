// Release-host recorder. It calls installed programs; it never loads a flow or
// executable from the repository being backed up. Receipts are diagnostic until
// the engineering receipt gate authenticates them at the released commit.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, writeFile, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function run(program, args, { env = {}, expected = 0, timeout = 30_000 } = {}) {
  const began = new Date().toISOString();
  const child = spawn(program, args, { env: { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env }, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(timeout) });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const status = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes); });
  const receipt = { began, ended: new Date().toISOString(), program, args, status, stdout, stderr };
  if (expected !== null && status !== expected) throw Object.assign(new Error(`command exited ${status}: ${program}`), { receipt });
  return receipt;
}

export async function config(path) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0) throw new Error('requires an unprivileged owner on an Apple Silicon Mac');
  const c = JSON.parse(await readFile(path, 'utf8'));
  // A released CLI is required. No branch-built host executable is accepted.
  c.cli = '/opt/homebrew/bin/smthrs';
  const cli = await realpath(c.cli);
  if (!cli.startsWith('/opt/homebrew/Cellar/smithers/')) throw new Error('CLI must be the tap-installed smithers keg');
  if (!c.commit || !c.evidence || !isAbsolute(c.evidence)) throw new Error('commit and absolute evidence directory required');
  c.state = join(homedir(), 'Library/Application Support/Smithers');
  c.evidence = resolve(c.evidence);
  // Keep diagnostic artifacts out of the state inventory.
  if (c.evidence === c.state || c.evidence.startsWith(c.state + '/')) throw new Error('evidence must be outside STATE');
  await mkdir(c.evidence, { recursive: true, mode: 0o700 });
  if (!c.psql || !isAbsolute(c.psql) || !(await realpath(c.psql)).startsWith('/opt/homebrew/Cellar/smithers/')) throw new Error('bundled psql required');
  return c;
}

export async function save(c, name, value) {
  await writeFile(join(c.evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export async function cli(c, args, expected = 0) {
  let receipt;
  try { receipt = await run(c.cli, ['host', ...args], { expected, timeout: 45 * 60_000 }); }
  catch (error) {
    if (error.receipt) await save(c, `command-${Date.now()}.json`, error.receipt);
    throw error;
  }
  await save(c, `command-${Date.now()}.json`, receipt);
  return receipt;
}

export async function hash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

export async function inventory(root, excluded = []) {
  if (!(await lstat(root)).isDirectory()) throw new Error('inventory root must be a directory');
  const result = [];
  async function walk(path) {
    const name = relative(root, path).split('\\').join('/');
    if (excluded.some(item => name === item || name.startsWith(item + '/'))) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) result.push({ path: name, mode: stat.mode & 0o777, link: await readlink(path) });
    else if (stat.isDirectory()) {
      result.push({ path: name, mode: stat.mode & 0o777, directory: true });
      for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    } else if (stat.isFile()) result.push({ path: name, mode: stat.mode & 0o777, size: stat.size, sha256: await hash(path) });
    else throw new Error(`non-file in inventory: ${name}`);
  }
  await walk(root);
  return result;
}

export async function capture(c) {
  if (!c.psql || !isAbsolute(c.psql) || !c.database || !Array.isArray(c.tables) || !c.tables.length) throw new Error('bundled psql, database and explicit table roster required');
  const pg = await realpath(c.psql);
  if (!pg.startsWith('/opt/homebrew/Cellar/smithers/')) throw new Error('psql must come from the installed bundle');
  const tables = [];
  for (const table of c.tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table.name) || (table.exclude ?? []).some(column => !/^[a-z_][a-z0-9_]*$/.test(column))) throw new Error('invalid table or migrated column');
    const omitted = (table.exclude ?? []).map(column => `'${column}'`).join(',');
    const row = `to_jsonb(t)${omitted ? ` - ARRAY[${omitted}]::text[]` : ''}`;
    const maintenanceRow = table.name === 'install_settings' ? " WHERE t.key <> 'quiesce'" : '';
    const query = `SELECT COALESCE(json_agg(r ORDER BY r::text), '[]'::json) FROM (SELECT ${row} AS r FROM "${table.name}" AS t${maintenanceRow}) AS rows`;
    const output = await run(c.psql, ['-X', '-qAt', '-c', query], { env: { PGDATABASE: c.database, PGOPTIONS: '-c default_transaction_read_only=on' } });
    const rows = JSON.parse(output.stdout);
    tables.push({ name: table.name, excluded: table.exclude ?? [], count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
  }
  return { commit: c.commit, at: new Date().toISOString(), tables, files: await inventory(c.state, ['backups', 'logs', 'postgres', 'run/host.sock', 'version.env', '.upgrade-incomplete']), profile: await hostProfile(c) };
}

export function compare(before, after) {
  if (JSON.stringify(before.tables) !== JSON.stringify(after.tables) || JSON.stringify(before.files) !== JSON.stringify(after.files)) throw new Error('independent database/tree digests differ');
  return { pass: true, before: before.at, after: after.at, tables: after.tables, files: after.files };
}

export function mainURL(meta) { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(meta); }

export async function verifyBackup(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new Error('backup directory must be 0700');
  const manifestStat = await lstat(join(directory, 'MANIFEST.json'));
  if (!manifestStat.isFile()) throw new Error('manifest must be a regular file');
  const manifest = JSON.parse(await readFile(join(directory, 'MANIFEST.json'), 'utf8'));
  if (!manifest.version || manifest.postgres_major !== 18 || !Number.isInteger(manifest.schema_version) || manifest.schema_version < 1 || !manifest.quiesce_op || !Number.isFinite(Date.parse(manifest.quiesce_time))) throw new Error('incomplete backup metadata');
  for (const key of ['stack', 'branch_heads', 'machine_disks', 'run_journals']) if (!manifest[key] || typeof manifest[key] !== 'object') throw new Error(`missing ${key} summary`);
  if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === 'postgres.dump' && !file.link)) throw new Error('missing dump');
  const observed = (await inventory(directory)).filter(file => !file.directory && file.path !== 'MANIFEST.json');
  const expected = new Map();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':') || file.path.includes('\0') || file.path.startsWith('/') || file.path.split('/').some(p => p === '' || p === '.' || p === '..') || expected.has(file.path)) throw new Error('unsafe or duplicate manifest path');
    if (/^state\/(backups|logs|postgres)(\/|$)/.test(file.path)) throw new Error('excluded state authority in backup');
    expected.set(file.path, file);
  }
  for (const file of observed) {
    const recorded = expected.get(file.path);
    if (!recorded || (file.link ? recorded.link !== file.link : recorded.size !== file.size || recorded.sha256 !== file.sha256 || recorded.link)) throw new Error(`backup mismatch: ${file.path}`);
    if (file.path === 'state/config/secrets.json' && file.mode !== 0o600) throw new Error('install key must be 0600');
    expected.delete(file.path);
  }
  if (expected.size) throw new Error('backup files missing');
  return { manifest, observed };
}

export async function hostProfile(c) {
  const hardware = (await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])).stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!hardware) throw new Error('missing physical host identity');
  return { uuid: hardware[1], ...(await run('/usr/bin/sw_vers', []) ), machine: (await run('/usr/sbin/sysctl', ['-n', 'hw.model'])).stdout.trim(), user: (await run('/usr/bin/id', ['-un'])).stdout.trim(), state: c.state };
}
