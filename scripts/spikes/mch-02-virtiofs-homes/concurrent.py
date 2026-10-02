"""C-SPK-02 follow-up: one member home, two real awake msb 0.6.16 VMs."""
import datetime as dt
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import shlex
import shutil
import signal
import sqlite3
import subprocess as sp
import sys
import tarfile
import tempfile
import time

PATHS = ('.claude', '.config/gh', '.npm/_cacache')
IMAGE = 'node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b'


def valid(row):
    return (isinstance(row, dict) and row.get('vm') in ('1', '2') and
            type(row.get('seq')) is int and 1 <= row['seq'] <= 1000 and
            row.get('payload') == f'{row["vm"]}:{row["seq"]:06d}:' + 'x' * 128)


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def summarize(home, workers):
    directories = {}
    for path in PATHS:
        base, found, faults = home / path, set(), []
        for file in sorted((base / 'records').glob('*')):
            row = load(file)
            if valid(row) and file.name == f'{row["vm"]}-{row["seq"]}.json':
                found.add((row['vm'], row['seq']))
            else:
                faults.append(file.name)
        seen, append_faults, last, ordered, append_order = set(), [], {}, True, []
        try:
            lines = (base / 'append.jsonl').read_bytes().splitlines()
        except OSError:
            lines = []
        for number, line in enumerate(lines, 1):
            try:
                row = json.loads(line)
            except ValueError:
                row = None
            if not valid(row) or (row['vm'], row['seq']) in seen:
                append_faults.append(number)
                continue
            key = row['vm'], row['seq']
            seen.add(key)
            ordered = ordered and row['seq'] > last.get(row['vm'], 0)
            last[row['vm']] = row['seq']
            append_order.append(f'{row["vm"]}:{row["seq"]}')
        observed_ordered, peer_stats = True, {}
        for worker in workers:
            previous = 0
            stats = dict(samples=0, visible=0, regressions=0, disappearances=0, invalid=0, errors={})
            error_codes = Counter()
            for obs in worker.get('observations', []):
                if obs.get('path') != path:
                    continue
                stats['samples'] += 1
                if obs.get('read_error') is not None:
                    error_codes[str(obs['read_error'])] += 1
                seq = obs.get('peer_seq')
                if seq is None:
                    if previous or obs.get('read_error') not in (None, 'ENOENT') or obs.get('peer_valid') is False:
                        observed_ordered = False
                        stats['disappearances'] += bool(previous)
                        stats['invalid'] += obs.get('peer_valid') is False
                    continue
                peer = '2' if worker.get('vm') == '1' else '1'
                if (type(seq) is not int or not previous <= seq <= 1000 or seq < 1 or
                        obs.get('read_error') is not None or obs.get('peer_vm', peer) != peer or
                        obs.get('peer_valid', True) is not True):
                    observed_ordered = False
                    stats['invalid'] += type(seq) is not int or obs.get('peer_valid', True) is not True
                    stats['regressions'] += type(seq) is int and seq < previous
                else:
                    previous = seq
                stats['visible'] += 1
            stats['errors'] = dict(error_codes)
            peer_stats[worker.get('vm', '?')] = stats
        directories[path] = dict(expected=2000, present=len(found), missing=2000-len(found),
            corrupted=len(faults), append_present=len(seen), append_missing=2000-len(seen),
            append_corrupted=len(append_faults), append_per_vm_ordered=ordered,
            observations_per_vm_ordered=observed_ordered, shared_valid=valid(load(base / 'shared.json')),
            record_faults=faults, append_fault_lines=append_faults, append_order=append_order,
            append_per_vm_counts=dict(Counter(vm for vm, _ in seen)), peer_observations=peer_stats,
            append_vm_switches=sum(a.split(':')[0] != b.split(':')[0] for a, b in zip(append_order, append_order[1:])))
    errors = sum(len(w.get('errors', [])) for w in workers)
    completed = (sorted(w.get('vm', '') for w in workers) == ['1', '2'] and
                 all(w.get('completed') is True and type(w.get('iterations')) is int and
                     w['iterations'] == 1000 and isinstance(w.get('errors'), list) for w in workers) and not errors)
    return dict(workers=workers, workers_completed=completed, worker_errors=errors, directories=directories)


def atomic_pass(data):
    if not isinstance(data, dict):
        return False
    workers, guests = data.get('workers', []), data.get('guests', [])
    if (not isinstance(workers, list) or not isinstance(guests, list) or
            not all(isinstance(row, dict) for row in [*workers, *guests]) or
            not isinstance(data.get('host'), dict)):
        return False
    if sorted(w.get('vm', '') for w in workers) != ['1', '2'] or sorted(g.get('vm', '') for g in guests) != ['1', '2']:
        return False
    for w in workers:
        if (w.get('uid') != 20001 or w.get('gid') != 20001 or w.get('completed') is not True or
                type(w.get('iterations')) is not int or w['iterations'] != 1000 or w.get('errors') != []):
            return False
        reads = w.get('shared_reads', [])
        if (not isinstance(reads, list) or len(reads) != 1000 or
                any(not isinstance(r, dict) or r.get('error') is not None or
                    not valid(r.get('observed')) for r in reads)):
            return False
    for view in [data.get('host', {}), *guests]:
        if (view.get('present') != 2000 or view.get('missing') != 0 or view.get('corrupted') != 0 or
                not valid(view.get('final')) or view['final']['seq'] != 1000):
            return False
        if 'final_reads' in view:
            reads = view['final_reads']
            if (not isinstance(reads, list) or not reads or
                    any(not isinstance(r, dict) or r.get('error') is not None or
                        not valid(r.get('observed')) for r in reads)):
                return False
        if view.get('sha_mismatches'):
            return False
    for guest in guests:
        if not guest.get('final_reads') or guest['final'] != data['host']['final']:
            return False
    return True


def extension_pass(result):
    return (isinstance(result, dict) and result.get('completed') is True and
            result.get('errors') == [] and result.get('unremoved_vms') == [] and
            atomic_pass(result.get('atomic')))


def lock_result(path, holder, contender, held, tried, control, held_during_attempt):
    controlled = (held_during_attempt is True and held.get('exit_code') == 0 and
                  control.get('exit_code') == 1)
    return dict(path=path, holder=holder, contender=contender, holder_receipt=held,
                contender_receipt=tried, same_vm_receipt=control,
                held_during_attempt=held_during_attempt, controlled=controlled,
                exclusion=controlled and tried.get('exit_code') == 1)


def main():
    args = sys.argv[1:]
    locks_only = bool(args and args[0] == '--locks-only')
    if locks_only:
        args = args[1:]
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    workspace = Path(__file__).resolve().parents[3]
    out = Path(args[0] if args else workspace / '.artifacts/checks/C-SPK-02' / stamp).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        sys.exit(f'Refusing nonempty evidence directory: {out}')
    binary = Path(os.environ.get('MSB_BIN') or shutil.which('msb') or '/missing-msb').resolve()
    if binary.suffix == '.cjs':
        machine = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
        native = binary.parent.parent / f'node_modules/@superradcompany/microsandbox-{platform.system().lower()}-{machine}/bin/msb'
        if native.is_file():
            binary = native
    env = dict(HOME=str(Path.home()), PATH=os.environ.get('PATH', '/usr/bin:/bin'), MSB_BACKEND='local', NO_COLOR='1')
    run_id = f'spike-mch02-{stamp.lower()}-{os.getpid()}-concurrent'
    owned, processes, scratch = [], [], None
    result = dict(check='C-SPK-02', extension='concurrent-home', completed=False, errors=[],
        host=dict(platform=platform.platform(), architecture=platform.machine(), uid=os.getuid()),
        image=IMAGE, mount_flag='--mount-dir SOURCE:DEST:uid=20001,gid=20001',
        boot_mount_note='Every member needs a mount at VM boot.', sqlite={}, locks=[], create_commands=[])
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    def record(args, p, elapsed_ms):
        row = dict(command=shlex.join([str(binary), *args]), exit_code=p.returncode,
                   stdout=p.stdout, stderr=p.stderr, elapsed_ms=elapsed_ms)
        with (out / 'commands.jsonl').open('a') as f:
            f.write(json.dumps(row) + '\n')
        return row

    def command(args, timeout=60):
        start = time.monotonic()
        p = sp.run([str(binary), *args], env=env, stdin=sp.DEVNULL, capture_output=True, text=True, timeout=timeout)
        row = record(args, p, (time.monotonic()-start)*1000)
        if p.returncode:
            raise RuntimeError(f'{row["command"]}: exit {p.returncode}: {p.stderr.strip()}')
        return row

    def guest(name, args):
        return ['exec', '--stream', '-u', '0', name, '--', *args]

    def member(name, args):
        return guest(name, ['setpriv', '--reuid', '20001', '--regid', '20001',
            '--clear-groups', 'env', 'HOME=/home/ben', *args])

    def pair(phase):
        jobs = []
        code = Path(__file__).with_name('concurrent-worker.cjs').read_text()
        for vm, name in zip(('1', '2'), names):
            args = member(name, ['node', '-', phase, vm])
            label = f'{phase}-vm{vm}'
            stdout, stderr = [(out / f'{label}.{suffix}').open('w') for suffix in ('stdout', 'stderr')]
            p = sp.Popen([str(binary), *args], env=env, stdin=sp.PIPE, stdout=stdout, stderr=stderr, text=True)
            processes.append(p)
            p.stdin.write(code)
            p.stdin.close()
            jobs.append((p, args, label, stdout, stderr))
        start, deadline = time.monotonic(), time.monotonic() + 60
        while not all((home / f'ready-{phase}-{vm}').exists() for vm in ('1', '2')):
            if any(p.poll() is not None for p, *_ in jobs) or time.monotonic() > deadline:
                raise RuntimeError(f'{phase}: worker exited or readiness timed out; see worker logs')
            time.sleep(0.05)
        (home / f'start-{phase}').write_text('start')
        print(f'{phase}: both workers ready, released common barrier', flush=True)
        last_update = time.monotonic()
        while any(p.poll() is None for p, *_ in jobs):
            if time.monotonic() - start > 600:
                raise RuntimeError(f'{phase}: 600 s worker deadline exceeded')
            if time.monotonic() - last_update > 30:
                print(f'{phase}: workers still running ({time.monotonic()-start:.0f}s)', flush=True)
                last_update = time.monotonic()
            time.sleep(0.1)
        workers = []
        for p, args, label, stdout, stderr in jobs:
            stdout.close()
            stderr.close()
            text = (out / f'{label}.stdout').read_text()
            record(args, sp.CompletedProcess(args, p.returncode, text,
                (out / f'{label}.stderr').read_text()), (time.monotonic()-start)*1000)
            rows = [json.loads(line[7:]) for line in text.splitlines() if line.startswith('RESULT ')]
            if p.returncode or len(rows) != 1 or rows[0]['uid'] != 20001 or rows[0]['gid'] != 20001:
                raise RuntimeError(f'{label}: failed worker or wrong guest identity; see worker logs')
            workers.append(rows[0])
        print(f'{phase}: two workers finished; {sum(len(w["errors"]) for w in workers)} operation errors', flush=True)
        return workers

    def audit_sqlite(phase, workers):
        audit = {}
        for path in PATHS:
            acknowledged = {(w['vm'], seq) for w in workers
                for seq in w.get('sqlite', {}).get(path, {}).get('succeeded', [])}
            data = dict(acknowledged=len(acknowledged), integrity=None, errors=[])
            try:
                db = sqlite3.connect(f'file:{home/path/phase}.sqlite?mode=ro', uri=True, timeout=1)
                try:
                    data['integrity'] = [row[0] for row in db.execute('PRAGMA integrity_check')]
                    rows = [dict(vm=v, seq=s, payload=p) for v, s, p in db.execute('SELECT vm,seq,payload FROM writes')]
                    keys = {(r['vm'], r['seq']) for r in rows if valid(r)}
                    data.update(present=len(keys), corrupted=sum(not valid(r) for r in rows),
                        lost_acknowledged=len(acknowledged-keys),
                        lost_ids=sorted(acknowledged-keys), unacknowledged_ids=sorted(keys-acknowledged))
                finally:
                    db.close()
            except sqlite3.Error as e:
                data['errors'].append(str(e))
            audit[path] = data
        return dict(workers=workers, databases=audit, host_sqlite_version=sqlite3.sqlite_version)

    try:
        result['msb_version'] = command(['--version'])['stdout'].strip()
        if result['msb_version'] != 'msb 0.6.16':
            raise RuntimeError('Requires msb 0.6.16')
        command(['doctor'])
        if json.loads(command(['context', '--format', 'json'])['stdout'])['kind'] != 'local':
            raise RuntimeError('Requires local microVMs')
        (out / 'create-help.txt').write_text(command(['create', '--help'])['stdout'])
        result['revision'] = sp.check_output(['jj', '--ignore-working-copy', 'log', '--no-graph', '-r', '@', '-T', 'commit_id'], text=True).strip()
        result['source_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in Path(__file__).parent.glob('*') if p.is_file()}
        result['host']['hardware'] = sp.check_output(['sysctl', '-n', 'hw.model', 'machdep.cpu.brand_string', 'hw.memsize'], text=True).strip()
        result['disk_before'] = sp.check_output(['df', '-h', str(Path.home())], text=True)
        temporary = workspace / '.artifacts/spikes'
        temporary.mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix='mch02-concurrent-', dir=temporary))
        home = scratch / 'ben'
        home.mkdir(mode=0o700)
        for path in PATHS:
            (home / path / 'records').mkdir(parents=True, mode=0o700)
        for directory in home.rglob('*'):
            if directory.is_dir():
                directory.chmod(0o700)
        (home / '.spike').mkdir(mode=0o700)
        names = [f'{run_id}-{vm}' for vm in ('1', '2')]
        for name in names:
            if shutil.disk_usage(Path.home()).free < 8 * 1024**3:
                raise RuntimeError('Less than 8 GiB free; refusing VM disk')
            args = ['create', IMAGE, '--pull', 'if-missing', '--root-disk', '4096M',
                '-n', name, '-c', '2', '-m', '1024M', '-q', '--no-net', '--label', f'smithers.spike={run_id}',
                '--mount-dir', f'{home}:/home/ben:uid=20001,gid=20001']
            owned.append(name)
            result['create_commands'].append(command(args, timeout=600))
            command(guest(name, ['sh', '-ec', 'command -v setpriv; command -v flock; '
                'useradd -M -U -u 20001 -d /home/ben ben; stat -c "%u:%g %a %n" /home/ben; uname -a']))
            command(guest(name, ['node', '-e', 'console.log(JSON.stringify({node:process.version,sqlite:process.versions.sqlite}));']))
            command(guest(name, ['cat', '/proc/mounts']))
        print(f'Two awake VMs, one home. Evidence: {out}', flush=True)
        result['awake_before'] = [command(['inspect', name, '--format', 'json']) for name in names]
        if not locks_only:
            result['files'] = summarize(home, pair('files'))
            atomic_workers = pair('atomic')
            manifest, bad = [], []
            for vm in ('1', '2'):
                for seq in range(1, 1001):
                    file = home / '.spike' / f'vm{vm}-{seq}'
                    row = load(file)
                    correct = valid(row) and row['vm'] == vm and row['seq'] == seq
                    if not correct:
                        bad.append(file.name)
                    manifest.append(dict(path=file.name, exists=file.exists(), correct=correct,
                        sha256=hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None))
            (out / 'atomic-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            verify = '''const fs=require('node:fs'),{createHash}=require('node:crypto');
    const vm=process.argv[1],result={vm,present:0,missing:0,corrupted:0,final:null,manifest:[],final_reads:[]};
    for(const writer of ['1','2'])for(let seq=1;seq<=1000;seq++){
     const name='vm'+writer+'-'+seq;try{const bytes=fs.readFileSync('/home/ben/.spike/'+name),r=JSON.parse(bytes);
     const correct=r.vm===writer&&r.seq===seq&&r.payload===writer+':'+String(seq).padStart(6,'0')+':'+'x'.repeat(128);
     result.present+=correct?1:0;result.corrupted+=correct?0:1;
     result.manifest.push({path:name,correct,sha256:createHash('sha256').update(bytes).digest('hex')});
     }catch(e){if(e.code==='ENOENT')result.missing++;else result.corrupted++;result.manifest.push({path:name,error:e.code||e.message});}}
    const start=performance.now();do{try{result.final=JSON.parse(fs.readFileSync('/home/ben/.spike/shared.json'));
    result.final_reads.push({observed:result.final,error:null});if(result.final.seq===1000)break;
    }catch(e){result.final_reads.push({observed:null,error:e.code||e.message});}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}while(performance.now()-start<10000);
    console.log(JSON.stringify(result));'''
            guests = [json.loads(command(member(name, ['node', '-e', verify, vm]))['stdout'])
                for vm, name in zip(('1', '2'), names)]
            hashes = {m['path']: m['sha256'] for m in manifest}
            for view in guests:
                observed = {m['path']: m.get('sha256') for m in view['manifest']}
                view['sha_mismatches'] = [path for path, sha in hashes.items() if sha is None or observed.get(path) != sha]
            host = dict(present=2000-len(bad), missing=sum(not m['exists'] for m in manifest),
                corrupted=sum(m['exists'] and not m['correct'] for m in manifest), final=load(home/'.spike/shared.json'))
            result['atomic'] = dict(workers=atomic_workers, guests=guests, host=host)
            result['atomic']['passed'] = atomic_pass(result['atomic'])
            print(f'C-SPK-02 atomic step 6: {result["atomic"]["passed"]}', flush=True)
        # flock is advisory. Correct cross-VM exclusion would make contender exit 1.
        for path in PATHS:
            for holder, contender in ((names[0], names[1]), (names[1], names[0])):
                release = f'release-lock-{len(result["locks"])}'
                args = member(holder, ['flock', '-x', f'/home/ben/{path}/advisory.lock',
                    'sh', '-c', f'echo LOCK_HELD; while [ ! -f /home/ben/{release} ]; do sleep 0.05; done'])
                start = time.monotonic()
                p = sp.Popen([str(binary), *args], env=env, stdin=sp.DEVNULL,
                    stdout=sp.PIPE, stderr=sp.PIPE, text=True)
                processes.append(p)
                if not select.select([p.stdout], [], [], 10)[0]:
                    raise RuntimeError('flock holder readiness timed out')
                line = p.stdout.readline()
                if line.strip() != 'LOCK_HELD':
                    raise RuntimeError(f'flock did not acquire: {line}')
                control_args = member(holder, ['flock', '-n', f'/home/ben/{path}/advisory.lock', 'true'])
                begin = time.monotonic()
                control = sp.run([str(binary), *control_args], env=env, stdin=sp.DEVNULL,
                    capture_output=True, text=True, timeout=10)
                control = record(control_args, control, (time.monotonic()-begin)*1000)
                attempt = member(contender, ['flock', '-n', f'/home/ben/{path}/advisory.lock', 'true'])
                begin = time.monotonic()
                tried = sp.run([str(binary), *attempt], env=env, stdin=sp.DEVNULL,
                    capture_output=True, text=True, timeout=10)
                tried = record(attempt, tried, (time.monotonic()-begin)*1000)
                held_during_attempt = p.poll() is None
                (home / release).write_text('release')
                rest, err = p.communicate(timeout=10)
                held = record(args, sp.CompletedProcess(args, p.returncode, line+rest, err),
                    (time.monotonic()-start)*1000)
                result['locks'].append(lock_result(path, holder, contender, held, tried,
                    control, held_during_attempt))
                print(f'flock {path}: same-VM exit {control["exit_code"]}, cross-VM exit {tried["exit_code"]}', flush=True)
        if not locks_only:
            for mode in ('DELETE', 'WAL'):
                phase = 'sqlite-' + mode.lower()
                code = '''const {DatabaseSync}=require('node:sqlite');
    const mode=process.argv[1],phase=process.argv[2];
    for(const path of ['.claude','.config/gh','.npm/_cacache']) {
     const db=new DatabaseSync('/home/ben/'+path+'/'+phase+'.sqlite');
     db.exec('PRAGMA journal_mode='+mode+'; PRAGMA synchronous=FULL; CREATE TABLE writes(vm TEXT,seq INTEGER,payload TEXT,PRIMARY KEY(vm,seq))');
     console.log(JSON.stringify({path,journal_mode:db.prepare('PRAGMA journal_mode').get()}));db.close();}'''
                command(member(names[0], ['node', '-e', code, mode, phase]))
                workers = pair(phase)
                # Preserve raw databases before the host's independent SQLite verification opens them.
                with tarfile.open(out / f'{phase}-raw.tar.gz', 'w:gz') as archive:
                    for file in home.rglob(phase + '.sqlite*'):
                        archive.add(file, arcname=str(file.relative_to(home)))
                result['sqlite'][mode] = audit_sqlite(phase, workers)
        result['awake_after'] = [command(['inspect', name, '--format', 'json']) for name in names]
        result['host_stats'] = [dict(path=str(p.relative_to(home)), uid=p.stat().st_uid,
            gid=p.stat().st_gid, mode=oct(p.stat().st_mode & 0o7777)[2:]) for p in [home, *home.rglob('*')]]
        (out / 'host-ls-ln.txt').write_text(sp.check_output(['ls', '-lnR', str(home)], text=True))
        with tarfile.open(out / 'home-synthetic-state.tar.gz', 'w:gz') as archive:
            archive.add(home, arcname='ben')
        result['completed'] = True
    except BaseException as e:
        result['errors'].append(f'{type(e).__name__}: {e}')
    finally:
        for p in processes:
            if p.poll() is None:
                p.terminate()
        for name in owned[:]:
            try:
                command(['remove', '--force', '-q', name], timeout=120)
                owned.remove(name)
            except Exception as e:
                result['errors'].append(f'Cleanup {name}: {e}')
        for p in processes:
            try:
                p.wait(timeout=5)
            except sp.TimeoutExpired:
                p.kill() # Only a Popen process this invocation created.
                p.wait(timeout=5)
        result['unremoved_vms'] = owned
        if scratch is not None and not owned:
            try:
                if not (out / 'home-synthetic-state.tar.gz').exists():
                    with tarfile.open(out / 'home-synthetic-state.tar.gz', 'w:gz') as archive:
                        archive.add(scratch, arcname='partial-scratch')
                shutil.rmtree(scratch)
            except Exception as e:
                result['errors'].append(f'Archive/cleanup {scratch}: {e}')
                result['retained_scratch'] = str(scratch)
        result['disk_after'] = sp.check_output(['df', '-h', str(Path.home())], text=True)
        result['partial'] = True # This execution alone lacks the ownership/visibility matrix.
        result['scope'] = 'locks-only' if locks_only else 'concurrent-home'
        (out / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(f'Extension completed: {result["completed"]}; errors: {result["errors"]}', flush=True)
        print(f'Evidence: {out}', flush=True)
    if locks_only:
        return 0 if (result['completed'] and not result['errors'] and not owned and
                     len(result['locks']) == 6 and all(row['controlled'] for row in result['locks'])) else 1
    return 0 if extension_pass(result) else 1


if __name__ == '__main__':
    sys.exit(main())
