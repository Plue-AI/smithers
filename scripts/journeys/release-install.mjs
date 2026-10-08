// C-REL-02 diagnostic recorder; authenticated release qualification stays in
// homebrew-release.mjs. Never treat this recording as a passing check receipt.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { isMain } from '../workspace-packages.mjs';

const categories = ['distribution', 'provider', 'registry', 'apple'];
const hostname = value => {
  const host = value.toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) throw new Error(`Invalid hostname: ${value}`);
  return host;
};
export function classify(host, roster) {
  host = hostname(host);
  if (['smithers.sh', 'jjhub.tech'].some(domain => host === domain || host.endsWith(`.${domain}`))) return 'forbidden';
  // Exact names only: approving github.com never approves evil.github.com.
  for (const category of categories) if ((roster[category] ?? []).map(hostname).includes(host)) return category;
  return 'unclassified';
}

export function pouredBottle(output, version) {
  const info = JSON.parse(output);
  const formula = info.formulae?.filter(row => row.full_name === 'smithersai/tap/smithers');
  if (formula?.length !== 1 || formula[0].installed?.length !== 1) throw new Error('Expected exactly one installed tap keg');
  const installed = formula[0].installed[0];
  if (installed.version !== version.replace(/^v/, '') || installed.poured_from_bottle !== true) throw new Error('Release version was not poured from a bottle');
  return installed;
}

export async function command(program, args, evidence, name, timeout = 45 * 60_000) {
  const began = new Date().toISOString(), tick = performance.now();
  const log = createWriteStream(join(evidence, `${name}.jsonl`), { flags: 'wx', mode: 0o600 });
  const record = event => log.write(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  record({ event: 'start', uid: process.getuid(), program, args });
  let stdout = '', stderr = '', status = null, failure;
  try {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(timeout) });
    child.stdout.on('data', bytes => { stdout += bytes; record({ stream: 'stdout', text: bytes.toString() }); process.stdout.write(bytes); });
    child.stderr.on('data', bytes => { stderr += bytes; record({ stream: 'stderr', text: bytes.toString() }); process.stderr.write(bytes); });
    status = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes); });
    if (status !== 0) failure = `command exited ${status}`;
    if (/\bsudo\b|password\s*:/i.test(stdout + stderr)) failure = 'Privilege prompt in command output';
  } catch (error) { failure = error.message; }
  const result = { began, ended: new Date().toISOString(), durationMs: performance.now() - tick, uid: process.getuid(), program, args, status, failure, stdout, stderr };
  record({ event: 'end', ...result });
  await new Promise((yes, no) => { log.once('error', no); log.end(yes); });
  if (failure) throw Object.assign(new Error(failure), { receipt: result });
  return result;
}

export async function readiness(url, evidence, timeout = 60_000) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/readyz' || target.search || target.hash) throw new Error('Use a loopback /readyz URL without credentials');
  if (target.username || target.password) throw new Error('Readiness credentials are forbidden');
  const tick = performance.now(), began = new Date().toISOString(), attempts = [];
  let ready = false;
  while (performance.now() - tick < timeout) {
    try {
      const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(2000, timeout - (performance.now() - tick)))) });
      attempts.push({ at: new Date().toISOString(), status: response.status });
      await response.body?.cancel();
      if (response.status === 200) { ready = true; break; }
    } catch (error) { attempts.push({ at: new Date().toISOString(), error: error.message }); }
    if (performance.now() - tick < timeout) await new Promise(resolve => setTimeout(resolve, Math.min(250, timeout - (performance.now() - tick))));
  }
  const receipt = { began, ended: new Date().toISOString(), durationMs: performance.now() - tick, url: target.href, ready, attempts };
  await writeFile(join(evidence, 'readiness.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  if (!ready) throw new Error('Readiness timed out');
  return receipt;
}

export async function connections(path, roster, evidence, began, ended) {
  // Export the logging resolver's full session as JSONL {at, hostname}.
  // Retain the raw export, including rows outside the session, for review.
  const raw = await readFile(path, 'utf8');
  await writeFile(join(evidence, 'dns.jsonl'), raw, { flag: 'wx', mode: 0o600 });
  const rows = raw.split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line);
    if (!Number.isFinite(Date.parse(row.at))) throw new Error('Invalid DNS timestamp');
    return { at: row.at, hostname: hostname(row.hostname), category: classify(row.hostname, roster) };
  }).filter(row => Date.parse(row.at) >= Date.parse(began) && Date.parse(row.at) <= Date.parse(ended));
  await writeFile(join(evidence, 'connections.json'), JSON.stringify(rows, null, 2), { flag: 'wx', mode: 0o600 });
  if (!rows.length || rows.some(row => ['forbidden', 'unclassified'].includes(row.category))) throw new Error('Empty, forbidden or unclassified DNS evidence');
  return rows;
}

export async function journey(path) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0) throw new Error('Requires an unprivileged Apple Silicon macOS user');
  const c = JSON.parse(await readFile(path, 'utf8'));
  if (!isAbsolute(c.evidence ?? '') || !isAbsolute(c.dnsLog ?? '') || !/^[a-f0-9]{40}$/.test(c.commit ?? '') || !/^v[0-9]/.test(c.version ?? '')) throw new Error('Absolute evidence/dnsLog paths, release commit and version required');
  for (const key of Object.keys(c.hostnames ?? {})) if (!categories.includes(key)) throw new Error('Unknown hostname category');
  for (const hosts of Object.values(c.hostnames ?? {})) hosts.forEach(hostname);
  // New evidence directory only: do not overwrite an earlier session.
  await mkdir(c.evidence, { mode: 0o700 });
  const began = new Date().toISOString(), tick = performance.now();
  const session = { check: 'C-REL-02', authority: 'diagnostic-only', began, commit: c.commit, version: c.version, uid: process.getuid(), commands: [] };
  const netlog = createWriteStream(join(c.evidence, 'nettop.jsonl'), { flags: 'wx', mode: 0o600 });
  const nettop = spawn('/usr/bin/nettop', ['-m', 'route', '-L', '0', '-s', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let networkFailure, samples = 0, stopping = false;
  const closed = new Promise(resolve => {
    nettop.once('error', error => { networkFailure = error.message; resolve(); });
    nettop.once('close', status => { if (!stopping || (status !== 0 && status !== null)) networkFailure = `nettop exited early or failed: ${status}`; resolve(); });
  });
  for (const [stream, output] of [['stdout', nettop.stdout], ['stderr', nettop.stderr]]) output.on('data', bytes => {
    if (stream === 'stdout') samples++;
    netlog.write(JSON.stringify({ at: new Date().toISOString(), stream, text: bytes.toString() }) + '\n');
  });
  const run = async (program, args, name) => {
    try { const result = await command(program, args, c.evidence, name); session.commands.push(result); return result; }
    catch (error) { if (error.receipt) session.commands.push(error.receipt); throw error; }
  };
  try {
    await new Promise((yes, no) => { nettop.once('spawn', yes); nettop.once('error', no); });
    await run('/opt/homebrew/bin/brew', ['install', 'smithersai/tap/smithers'], 'install');
    const info = await run('/opt/homebrew/bin/brew', ['info', '--json=v2', 'smithersai/tap/smithers'], 'brew-info');
    session.pour = pouredBottle(info.stdout, c.version);
    const cli = await realpath('/opt/homebrew/bin/smthrs');
    if (!cli.startsWith('/opt/homebrew/Cellar/smithers/')) throw new Error('CLI is not the poured keg');
    session.cli = cli;
    await run('/opt/homebrew/bin/smthrs', ['host', 'start'], 'start');
    session.readiness = await readiness(c.readyURL ?? 'http://127.0.0.1:4000/readyz', c.evidence);
    await run('/opt/homebrew/bin/smthrs', ['host', 'status'], 'status');
    await run('/opt/homebrew/bin/smthrs', ['host', 'start'], 'repeat-start');
    await run('/bin/launchctl', ['print', `gui/${process.getuid()}/sh.smithers.host`], 'launchagent');
    await run('/bin/ps', ['-axo', 'uid,pid,ppid,command'], 'process-uids');
    // Keep connection capture alive during the manual setup/question steps.
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await input.question('Complete setup and the question in the recorded browser session; export the resolver log, then type done: ');
      if (answer !== 'done') throw new Error('Manual session incomplete');
    } finally { input.close(); }
    session.manualEnded = new Date().toISOString();
    await connections(c.dnsLog, c.hostnames ?? {}, c.evidence, began, session.manualEnded);
    if (networkFailure || !samples) throw new Error(networkFailure ?? 'No nettop samples');
    session.recorded = true;
  } catch (error) { session.failure = error.message; throw error; }
  finally {
    // Only stop the child this recorder started. The installed host stays up.
    stopping = true;
    nettop.kill('SIGTERM');
    await closed;
    await new Promise((yes, no) => { netlog.once('error', no); netlog.end(yes); });
    session.ended = new Date().toISOString();
    session.durationMs = performance.now() - tick;
    if (networkFailure) { session.failure ??= networkFailure; session.recorded = false; }
    await writeFile(join(c.evidence, 'session.json'), JSON.stringify(session, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (session.failure) throw new Error(session.failure);
  return session;
}

if (isMain(import.meta)) {
  if (process.argv.includes('--help')) console.log('node scripts/journeys/release-install.mjs <owner-config.json> (see C-REL-02)');
  else journey(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
