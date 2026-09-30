/**
 * The isolated POSIX group owner. Kept as source because the same fixed program
 * runs in Node and Bun without loading the caller's modules or configuration.
 * Its behavior is exercised through the real prepared lifecycle tests.
 * @private
 * @since 1.0.0
 */
export const source = String.raw`
// A fault of the owner itself: reason is its stable code on the status wire.
class SupervisorFault extends Error {
  constructor(reason, message) { super(message); this.name = 'SupervisorFault'; this.reason = reason; }
}
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const [socketPath, mode] = process.argv.slice(-2);
const grouped = mode === 'group';
const jobHelper = process.env.SMITHERS_PROCESS_JOB_HELPER;
delete process.env.SMITHERS_PROCESS_JOB_HELPER;
let created;
if (jobHelper !== undefined) {
  // The still-live owner observes itself. A later PID reuse cannot replace this
  // identity with a different process before the guardian attaches its job.
  const result = cp.spawnSync(jobHelper, ['--process-identity', String(process.pid)], {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, env: {}
  });
  if (result.error || result.signal !== null || result.status !== 0) throw new SupervisorFault('owner_identity_unavailable', 'Owner identity unavailable');
  const identity = JSON.parse(result.stdout);
  if (identity?.status !== 'started' || typeof identity.created !== 'string' || !/^[1-9][0-9]{0,19}$/.test(identity.created)) {
    throw new SupervisorFault('owner_identity_unavailable', 'Owner creation identity unavailable');
  }
  created = identity.created;
}
const channel = process.env.SMITHERS_PROCESS_CHANNEL ? JSON.parse(process.env.SMITHERS_PROCESS_CHANNEL) : undefined;
delete process.env.SMITHERS_PROCESS_CHANNEL;
const connect = path => channel === undefined ? net.connect(path) : require('node:tls').connect({
  minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256',
  host: '127.0.0.1', port: path.endsWith('/r') ? channel.requests : channel.status,
  pskCallback: () => ({ identity: 'smithers-owner', psk: Buffer.from(channel.key, 'hex') })
});
const control = connect(socketPath);
// A request write racing our exit may get EPIPE. Keep status on its own
// connection so the host still receives the exit and cleanup already sent.
const requests = connect(socketPath.replace(/\/s$/, '/r'));
let config;
let target;
let targetDone = false;
let stopping = false;
let explicitStop = false;
let killing = false;
let buffer = '';
let timer;
let escaped = new Map();

// DirectorySandbox's trusted local explicit-stop contract also covers children
// that deliberately create another session. This is best-effort positive-pid
// signalling with identity revalidation, not the atomic own-group guarantee.
// Linux reads its kernel table because slim images ship no procps (and BusyBox
// ps lacks these columns); other POSIX hosts ask their system ps.
const procSnapshot = () => {
  let names;
  try { names = fs.readdirSync('/proc'); }
  catch { throw new SupervisorFault('descendant_observation_unavailable', 'Descendant observation unavailable'); }
  const rows = new Map();
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    let text;
    try { text = fs.readFileSync('/proc/' + name + '/stat', 'utf8'); }
    catch (error) {
      // A process that ended after the listing is not an unreadable table.
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw new SupervisorFault('descendant_observation_unavailable', 'Descendant observation unavailable');
    }
    // comm may contain spaces and parentheses; fields follow its last paren.
    const close = text.lastIndexOf(')');
    const head = text.slice(0, text.indexOf('(')).trim();
    const fields = text.slice(close + 1).trim().split(/[ \t]+/);
    if (close < 0 || head !== name || fields.length < 20) throw new SupervisorFault('descendant_observation_invalid', 'Invalid descendant observation');
    // Fields 4, 5 and 22: parent, group and start time in clock ticks since boot.
    const [pid, parent, group, start] = [head, fields[1], fields[2], fields[19]].map(Number);
    if (![pid, parent, group, start].every(Number.isSafeInteger)) throw new SupervisorFault('descendant_identity_invalid', 'Invalid descendant identity');
    rows.set(pid, { pid, parent, group, start, zombie: fields[0] === 'Z' });
  }
  return rows;
};
const psSnapshot = () => {
  const result = cp.spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 500, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
  });
  if (result.error || result.status !== 0) throw new SupervisorFault('descendant_observation_unavailable', 'Descendant observation unavailable');
  const rows = new Map();
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new SupervisorFault('descendant_observation_invalid', 'Invalid descendant observation');
    const [pid, parent, group] = match.slice(1, 4).map(Number);
    const start = Date.parse(match[5]);
    if (![pid, parent, group, start].every(Number.isSafeInteger)) throw new SupervisorFault('descendant_identity_invalid', 'Invalid descendant identity');
    rows.set(pid, { pid, parent, group, start, zombie: match[4].startsWith('Z') });
  }
  return rows;
};
const snapshot = process.platform === 'linux' ? procSnapshot : psSnapshot;
const captureEscaped = () => {
  const rows = snapshot();
  const descendants = new Set([target.pid]);
  for (;;) {
    const previous = descendants.size;
    for (const row of rows.values()) if (descendants.has(row.parent)) descendants.add(row.pid);
    if (descendants.size === previous) break;
  }
  for (const pid of descendants) {
    const row = rows.get(pid);
    if (row && !row.zombie && row.group !== process.pid && pid !== process.pid && pid > 1) escaped.set(pid, row);
  }
};
const signalEscaped = (signal) => {
  if (escaped.size === 0) return;
  const rows = snapshot();
  for (const [pid, recorded] of escaped) {
    const row = rows.get(pid);
    if (!row || row.zombie) { escaped.delete(pid); continue; }
    if (row.start !== recorded.start || row.group !== recorded.group) {
      throw new SupervisorFault('descendant_identity_changed', 'Escaped descendant identity changed before signalling');
    }
    try { process.kill(pid, signal); }
    catch (error) { if (error.code === 'ESRCH') escaped.delete(pid); else throw error; }
  }
};
const cleanupError = (error) => send({ type: 'cleanup_error', reason: error.reason, message: String(error.message).slice(0, 2048) });
const escapedSettled = () => {
  if (escaped.size === 0) return true;
  const rows = snapshot();
  for (const [pid, recorded] of escaped) {
    const row = rows.get(pid);
    if (!row || row.zombie) { escaped.delete(pid); continue; }
    if (row.start !== recorded.start || row.group !== recorded.group) {
      throw new SupervisorFault('descendant_identity_changed', 'Escaped descendant identity changed before cleanup verification');
    }
  }
  return escaped.size === 0;
};

const send = (message, done = () => {}) => {
  if (control.destroyed || !control.writable) return done();
  control.write(JSON.stringify(message) + '\n', done);
};
const selfKill = () => process.kill(grouped ? -process.pid : process.pid, 'SIGKILL');
const force = () => {
  if (killing) return;
  killing = true;
  if (!grouped && target?.pid !== undefined && !targetDone) {
    target.kill('SIGKILL');
    return;
  }
  try { signalEscaped('SIGKILL'); } catch (error) { cleanupError(error); }
  const deadline = Date.now() + 500;
  const complete = () => {
    try {
      if (!escapedSettled()) {
        if (Date.now() < deadline) { setTimeout(complete, 10); return; }
        throw new SupervisorFault('descendants_unsettled', 'Escaped descendants did not settle before the cleanup bound');
      }
    } catch (error) { cleanupError(error); }
    // TLS write completion does not prove the peer received terminal status.
    // Keep the owner alive for its receipt; an unresponsive host still cannot
    // delay cleanup beyond the existing delivery bound.
    setTimeout(selfKill, 100);
    send({ type: 'cleanup' }, config?.acknowledgeCleanup ? () => {} : selfKill);
  };
  complete();
};
const stop = (options = {}) => {
  // The first explicit stop owns its signal and deadline, including after EOF
  // or target exit. Only natural cleanup can accept the host's fast shortcut.
  if (stopping && (explicitStop || !options.fast)) return;
  const signal = options.killSignal ?? config?.killSignal ?? 'SIGTERM';
  // A target's exit cannot shorten a captured escaped child's grace period.
  if (options.fast && escaped.size !== 0) return;
  // A grouped owner reaches its members with one group signal and captures
  // only children that left the group. A direct target shares the host's
  // group, so every descendant is captured and signalled by pid.
  if (options.explicit && !targetDone && target?.pid !== undefined) {
    try { captureEscaped(); } catch (error) { cleanupError(error); }
  }
  stopping = true;
  explicitStop = options.explicit === true;
  if (signal === 'SIGKILL' || target?.pid === undefined || (!grouped && targetDone)) return force();
  if (signal === 'SIGSTOP') return force();
  // Keep the group owner alive to enforce escalation, including when the caller
  // chooses a catchable signal other than TERM/INT. SIGSTOP is refused by host.
  process.on(signal, () => {});
  try { signalEscaped(signal); } catch (error) { cleanupError(error); }
  if (grouped) process.kill(-process.pid, signal);
  else target.kill(signal);
  timer = setTimeout(force, options.graceMs ?? config?.graceMs ?? 2000);
};
// The grace window exists for the group's remaining members. Once the target
// has exited and a snapshot shows no other live member and no escaped child,
// nobody is left to wait for: finish now instead of sleeping out the grace.
// An unreadable table keeps the deadline.
const settleVacantGroup = () => {
  if (!stopping || killing || escaped.size !== 0) return;
  let rows;
  try { rows = snapshot(); } catch { return; }
  for (const row of rows.values()) {
    // The owner's only other child is the ps answering this snapshot; the
    // exited target is already reaped and its orphans have another parent.
    if (row.group === process.pid && row.pid !== process.pid && row.parent !== process.pid && !row.zombie) return;
  }
  clearTimeout(timer);
  force();
};
const spawnError = (error) => {
  send({ type: 'spawn_error', code: error.code, errno: error.errno,
    syscall: error.syscall, path: error.path, message: String(error.message).slice(0, 2048) });
  stop();
};
process.on('SIGTERM', () => { if (!stopping) stop(); });
process.on('SIGINT', () => { if (!stopping) stop(); });
process.on('uncaughtException', (error) => {
  try { send({ type: 'fault', reason: error.reason, message: String(error.message).slice(0, 2048) }, force); }
  finally { force(); }
});
process.on('unhandledRejection', (error) => { throw error; });
control.on('end', () => stop({ explicit: true }));
control.on('error', () => stop({ explicit: true }));
requests.on('end', () => stop({ explicit: true }));
requests.on('error', () => stop({ explicit: true }));
requests.setEncoding('utf8');
requests.on('data', (data) => {
  buffer += data;
  if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new SupervisorFault('control_frame_too_large', 'Control frame too large');
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.type === 'configure') {
      if (config !== undefined || stopping) throw new SupervisorFault('configuration_invalid', 'Duplicate or late configuration');
      config = message;
    } else if (message.type === 'cleanup_ack') {
      if (!config?.acknowledgeCleanup || !killing) throw new SupervisorFault('cleanup_acknowledgment_unexpected', 'Unexpected cleanup acknowledgment');
      selfKill();
    } else if (message.type === 'stop') stop(message);
    else if (message.type === 'start') {
      if (config === undefined || target !== undefined || stopping) throw new SupervisorFault('activation_invalid', 'Invalid activation');
      const descriptors = Array.from({ length: Math.max(2, ...config.userFds) + 1 }, () => 'ignore');
      for (const fd of [0, 1, 2, ...config.userFds]) descriptors[fd] = fd;
      if (config.standardFds !== undefined) {
        for (const fd of [0, 1, 2]) descriptors[fd] = config.standardFds[fd];
      }
      try {
        target = cp.spawn(config.command, config.args, {
          cwd: config.cwd, env: config.env, shell: config.shell,
          windowsHide: config.windowsHide, windowsVerbatimArguments: config.windowsVerbatimArguments,
          detached: false, stdio: descriptors
        });
      } catch (error) { spawnError(error); continue; }
      target.once('spawn', () => {
        // Release every caller pipe copy. Keep the runtime's standard slots
        // valid so a later internal allocation cannot reuse a closed 0/1/2.
        if (config.standardFds !== undefined) {
          // libuv intentionally does not close Windows CRT descriptors 0..2.
          // Caller pipes arrive in separate slots; the reserved slots are NUL.
          for (const fd of config.standardFds) if (fd !== 'ignore') fs.closeSync(fd);
        } else {
          for (const fd of [0, 1, 2]) {
            fs.closeSync(fd);
            const replacement = fs.openSync(require('node:os').devNull, fd === 0 ? 'r' : 'w');
            if (replacement !== fd) throw new SupervisorFault('stream_detach_failed', 'Could not detach supervisor standard streams');
          }
        }
        for (const fd of config.userFds) fs.closeSync(fd);
        send({ type: 'spawned', pid: target.pid });
      });
      target.once('error', spawnError);
      target.once('exit', (code, signal) => {
        targetDone = true;
        send({ type: 'exit', code, signal });
        if (grouped) { stop(); settleVacantGroup(); }
        else { killing = false; clearTimeout(timer); force(); }
      });
    } else throw new SupervisorFault('control_message_invalid', 'Invalid control message');
  }
});
control.once('connect', () => send({ type: 'ready', version: 1, pid: process.pid, created }));
`
