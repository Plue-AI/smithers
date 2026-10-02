#!/usr/bin/env bash
# C-SPK-02: local msb 0.6.16, DefaultImage; no package dependencies.
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${1:-}" == "--concurrent" ]]; then
  shift
  exec python3 -B concurrent.py "$@"
fi
exec python3 -B - "$@" <<'PY'
import csv
import datetime as dt
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import signal
import subprocess as sp
import sys
import tempfile
import time

from verdict import evaluate

IMAGE = 'node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b'
stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
out = Path(sys.argv[1] if len(sys.argv) > 1 else
           Path.cwd().parents[2] / '.artifacts/checks/C-SPK-02' / stamp).resolve()
out.mkdir(parents=True, exist_ok=True)
if any(out.iterdir()):
    sys.exit(f'Refusing nonempty evidence directory: {out}')
binary = Path(os.environ.get('MSB_BIN') or shutil.which('msb') or '/missing-msb').resolve()
# The npm launcher needs node on PATH; use its native executable as the backend does.
if binary.suffix == '.cjs':
    machine = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
    native = binary.parent.parent / f'node_modules/@superradcompany/microsandbox-{platform.system().lower()}-{machine}/bin/msb'
    if native.is_file():
        binary = native
env = {'HOME': str(Path.home()), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
       'MSB_BACKEND': 'local', 'NO_COLOR': '1'}
run_id = f'spike-mch02-{stamp.lower()}-{os.getpid()}'
owned = []
scratch = None
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
result = {'check': 'C-SPK-02', 'completed': False, 'host_uid': os.getuid(),
          'host': {'platform': platform.platform(), 'architecture': platform.machine()},
          'msb_binary': str(binary), 'image': IMAGE, 'layouts': {}, 'errors': []}

def command(args, timeout=60, required=False):
    started = time.monotonic()
    try:
        p = sp.run([str(binary), *args], env=env, stdin=sp.DEVNULL,
                   capture_output=True, text=True, timeout=timeout)
        record = {'command': shlex.join([str(binary), *args]), 'exit_code': p.returncode,
                  'stdout': p.stdout, 'stderr': p.stderr}
    except sp.TimeoutExpired as e:
        record = {'command': shlex.join([str(binary), *args]), 'exit_code': 124,
                  'stdout': (e.stdout or b'').decode(), 'stderr': (e.stderr or b'').decode() + '\nTIMEOUT'}
    record['elapsed_ms'] = (time.monotonic() - started) * 1000
    with (out / 'commands.jsonl').open('a') as log:
        log.write(json.dumps(record) + '\n')
    if required and record['exit_code'] != 0:
        raise RuntimeError(f"{record['command']}: exit {record['exit_code']}: {record['stderr'].strip()}")
    return record

def guest(name, args, required=False):
    return command(['exec', '--stream', '-u', '0', name, '--', *args], required=required)

# Run actual setpriv processes; read errors retain syscall errno, not just cat's exit 1.
MATRIX = r'''
const fs = require('fs'), {spawnSync} = require('child_process');
const [layout, phase] = process.argv.slice(1), steps = [];
function run(kind, member, argv, actor_uid) {
  const p = spawnSync(argv[0], argv.slice(1), {encoding:'utf8'});
  let data; try { data = JSON.parse(p.stdout); } catch {}
  steps.push({phase, kind, member, actor_uid, command:argv,
    exit_code:p.status ?? 127, stdout:p.stdout, stderr:p.stderr, data});
}
const IO = `const fs=require('fs'); const [op,path,value]=process.argv.slice(1);
let data={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),errno:null};
try { if(op==='write') {fs.mkdirSync(require('path').dirname(path),{recursive:true,mode:0o700});
const fd=fs.openSync(path,'w',0o600);fs.writeSync(fd,value);fs.fsyncSync(fd);fs.closeSync(fd);}
else data.value=fs.readFileSync(path,'utf8'); }
catch(e) {data.errno=e.code; data.message=e.message; process.exitCode=1;}
console.log(JSON.stringify(data));`;
run('mount_root','.', ['stat','-c','%u:%g %a %n','/home']);
for (const [member, uid, other] of [['ben',20001,20002],['alice',20002,20001]]) {
  const home='/home/'+member, path=home+'/.config/tool/login.json';
  if (phase==='initial') {
    if(layout==='A') {
      run('mkdir',member,['mkdir',home]);
      run('chown',member,['chown',`${uid}:${uid}`,home]);
    }
    run('chmod',member,['chmod','0700',home]);
  }
  run('stat',member,['node','-e',`const s=require('fs').statSync(process.argv[1]);
console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:(s.mode&0o7777).toString(8)}));`,home]);
  if(phase==='initial') run('write',member,['setpriv','--reuid',String(uid),'--regid',String(uid),
    '--clear-groups','node','-e',IO,'write',path,'login-'+member],uid);
  for(const actor of [uid,other,19999]) run('read',member,['setpriv','--reuid',String(actor),
    '--regid',String(actor),'--clear-groups','node','-e',IO,'read',path],actor);
}
console.log(JSON.stringify(steps));
'''
WRITE = r'''
const fs=require('fs'); const value=process.argv[1];
const fd=fs.openSync('/home/ben/.config/tool/login.json','w');
fs.writeSync(fd,value); fs.fsyncSync(fd); fs.closeSync(fd);
'''
READ = r'''
const fs=require('fs'), expected=process.argv[1], start=performance.now();
let observed=null,error=null, observed_after_1s=null;
do { try {observed=fs.readFileSync('/home/ben/.config/tool/login.json','utf8');error=null;}
catch(e){error=e.code;} if(observed===expected) break;
if(error==='EACCES') break; // Permanent permission failure; retain every failed sample.
if(performance.now()-start>=1000 && observed_after_1s===null) observed_after_1s=observed;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
} while(performance.now()-start<10000); // Observation bound, distinct from the p95 <=1 s gate.
console.log(JSON.stringify({observed,error,observed_after_1s,poll_ms:performance.now()-start}));
if(observed!==expected) process.exitCode=1;
'''

def as_ben(name, code, value):
    return guest(name, ['setpriv', '--reuid', '20001', '--regid', '20001',
                        '--clear-groups', 'node', '-e', code, value])

try:
    version = command(['--version'], required=True)
    result['msb_version'] = version['stdout'].strip()
    if result['msb_version'] != 'msb 0.6.16':
        raise RuntimeError('Requires msb 0.6.16')
    doctor = command(['doctor'], required=True)
    if 'Host setup is ready' not in doctor['stdout'] + doctor['stderr']:
        raise RuntimeError('msb doctor did not report a ready host')
    context = command(['context', '--format', 'json'], required=True)
    if json.loads(context['stdout'])['kind'] != 'local':
        raise RuntimeError('Requires local microVMs')
    result['host']['hardware'] = sp.check_output(
        ['sysctl', '-n', 'hw.model', 'machdep.cpu.brand_string', 'hw.memsize'], text=True).strip()
    result['revision'] = sp.check_output(['jj', '--ignore-working-copy', 'log', '--no-graph', '-r', '@',
        '-T', 'commit_id'], text=True, stderr=sp.DEVNULL).strip()
    result['disk_before'] = sp.check_output(['df', '-h', str(Path.home())], text=True)
    if shutil.disk_usage(Path.home()).free < 8 * 1024**3:
        raise RuntimeError('Less than 8 GiB free; refusing VM disks')
    temporary = Path.cwd().parents[2] / '.artifacts/spikes'
    temporary.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix='mch02-', dir=temporary))
    os.chmod(scratch, 0o700)
    for layout in ('A', 'B'):
        print(f'{layout}: booting two owned microVMs; evidence {out}', flush=True)
        homes = scratch / layout / 'homes'
        homes.mkdir(parents=True, mode=0o700)
        mounts = ['--mount-dir', f'{homes}:/home']
        if layout == 'B':
            mounts = []
            for member, uid in [('ben', 20001), ('alice', 20002)]:
                (homes / member).mkdir(mode=0o700)
                mounts += ['--mount-dir', f'{homes/member}:/home/{member}:uid={uid},gid={uid}']
        data = {'steps': [], 'samples': [], 'host': [],
                'boot_mounts_required': layout == 'B',
                'boot_mount_note': 'Every member needs a mount at VM boot.' if layout == 'B' else ''}
        result['layouts'][layout] = data
        names = [f'{run_id}-{layout.lower()}{i}' for i in (1, 2)]
        # Smaller shape than runtime defaults on this shared host; same image/create/root disk path.
        for name in names:
            if shutil.disk_usage(Path.home()).free < 8 * 1024**3:
                raise RuntimeError('Less than 8 GiB free; stopping this spike')
            owned.append(name) # Unique names; no --replace and never target another VM.
            command(['create', IMAGE, '--pull', 'if-missing', '--root-disk', '4096M',
                     '-n', name, '-c', '2', '-m', '1024M', '-q', '--no-net',
                     '--label', f'smithers.spike={run_id}', *mounts], timeout=600, required=True)
            guest(name, ['sh', '-ec',
                'command -v setpriv; '
                'useradd -M -U -u 20001 -d /home/ben ben; '
                'useradd -M -U -u 20002 -d /home/alice alice; '
                'useradd -M -U -u 19999 agent; uname -a; '
                'id ben; id alice; id agent; cat /proc/mounts'], required=True)
        for phase, name in [('initial', names[0]), ('reboot', names[0]), ('second_vm', names[1])]:
            if phase == 'reboot':
                guest(name, ['sync'], required=True)
                command(['stop', '-t', '10', '-q', name], required=True)
                command(['start', '-q', name], timeout=300, required=True)
            raw = guest(name, ['node', '-e', MATRIX, layout, phase], required=True)
            steps = json.loads(raw['stdout'])
            for step in steps:
                step['vm'] = 2 if phase == 'second_vm' else 1
            data['steps'] += steps
            print(f'{layout}: {phase} captured ({sum(s["exit_code"] != 0 for s in steps)} nonzero operations)', flush=True)
        with (out / f'{layout}-delays.csv').open('w') as f:
            fields = ['seq', 'expected', 'observed', 'write_exit_code', 'read_exit_code',
                      'delay_ms', 'ack_to_read_ms', 'guest_poll_ms', 'observed_after_1s']
            writer = csv.DictWriter(f, fields)
            writer.writeheader()
            for seq in range(1, 101):
                value = f'mch02-{seq}'
                begin = time.monotonic()
                write = as_ben(names[0], WRITE, value)
                acknowledged = time.monotonic()
                read = as_ben(names[1], READ, value)
                end = time.monotonic()
                try:
                    observed = json.loads(read['stdout'])
                except ValueError:
                    observed = {}
                sample = {'seq': seq, 'expected': value, 'observed': observed.get('observed'),
                          'write_exit_code': write['exit_code'], 'read_exit_code': read['exit_code'],
                          # Conservative bound from before write launch to after observed read.
                          'delay_ms': (end - begin) * 1000,
                          'ack_to_read_ms': (end - acknowledged) * 1000,
                          'guest_poll_ms': observed.get('poll_ms'),
                          'observed_after_1s': observed.get('observed_after_1s')}
                data['samples'].append(sample)
                writer.writerow(sample)
                f.flush()
                if seq % 25 == 0:
                    print(f'{layout}: {seq}/100 cross-VM samples', flush=True)
        if layout == 'B':
            third = scratch / 'third-member'
            third.mkdir(mode=0o700)
            data['hot_add'] = {
                'attempt': command(['modify', names[0], '--mount-dir',
                                    f'{third}:/home/carol:uid=20003,gid=20003']),
                'guest_after': guest(names[0], ['stat', '-c', '%u:%g %a', '/home/carol'])}
        for path in [homes, *sorted(homes.rglob('*'))]:
            st = path.stat()
            data['host'].append({'path': str(path.relative_to(homes)), 'uid': st.st_uid,
                                 'gid': st.st_gid, 'mode': oct(st.st_mode & 0o7777)[2:]})
        listing = sp.run(['ls', '-lnR', str(homes)], capture_output=True, text=True)
        (out / f'{layout}-host-ls-ln.txt').write_text(listing.stdout + listing.stderr)
        for name in names:
            command(['remove', '--force', '-q', name], timeout=120, required=True)
            owned.remove(name)
    result['completed'] = True
except BaseException as e:
    result['errors'].append(f'{type(e).__name__}: {e}')
    print(result['errors'][-1], file=sys.stderr, flush=True)
finally:
    for name in owned[:]:
        try:
            command(['remove', '--force', '-q', name], timeout=120, required=True)
            owned.remove(name)
        except Exception as e:
            result['errors'].append(f'Cleanup {name}: {e}')
    result['unremoved_vms'] = owned
    if scratch is not None and not owned:
        shutil.rmtree(scratch)
    result['disk_after'] = sp.check_output(['df', '-h', str(Path.home())], text=True)
    # Preserve the matrix independently, then execute mandatory step 6 even if
    # a measured matrix criterion failed. Execution/cleanup failures stop here.
    (out / 'matrix-results.json').write_text(json.dumps(result, indent=2) + '\n')
    if result['completed'] and not result['errors'] and not owned:
        print('Matrix captured; running concurrent atomic-write step 6.', flush=True)
        try:
            execution = sp.run([sys.executable, '-B', 'concurrent.py', str(out / 'concurrent')])
            result['concurrent_exit_code'] = execution.returncode
            result['concurrent'] = json.loads((out / 'concurrent/results.json').read_text())
        except (OSError, ValueError) as e:
            result['errors'].append(f'Concurrent step 6: {e}')
    result['verdict'] = evaluate(result)
    (out / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    summary = ', '.join(f'layout {k}: {"YES" if v["passed"] else "NO"}, p95={v["p95_ms"]} ms'
                        for k, v in result['verdict']['layouts'].items())
    print(f'C-SPK-02: {"YES" if result["verdict"]["passed"] else "NO"} ({summary})', flush=True)
    print(f'Evidence: {out}', flush=True)
    (out / 'check-summary.json').write_text(json.dumps(result['verdict'], indent=2) + '\n')
sys.exit(0 if result['verdict']['passed'] else 1)
PY
