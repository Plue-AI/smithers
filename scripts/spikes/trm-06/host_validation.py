"""Installed native launcher replacement campaign; never mutate the live bundle.

The owner provisions a disposable native chroot at FIXTURE, including OS Python,
sh, ps, devfs and a complete approved same-revision bundle at /trm06-baseline.
Run this installed main-pinned harness with an empty startup environment as root.
The gateway only reads the resulting root-owned receipt; it never elevates.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import shlex
import shutil
import stat
import subprocess
import sys
import time

ROOT = Path('/usr/local/lib/smithers/current')
FIXTURE = Path('/private/var/root/smithers-trm06-host-validation')
RECEIPT = Path('/usr/local/lib/smithers/trm06-host-validation.json')
REFUSAL = b'{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}\n'
LEAVES = ('manifest.json', 'share/trm06/launcher.py', 'share/trm06/run.sh',
          'share/trm06/revoke.sh', 'share/trm06/flow.sh', 'bin/trm06-gateway')
PARENTS = ('/usr/local', '/usr/local/lib', '/usr/local/lib/smithers', '.',
           'bin', 'share', 'share/trm06')


def schedules():
    result = [('bootstrap', leaf, mutation)
              for leaf in ('/usr/local', '/usr/local/lib', '/usr/local/lib/smithers', '.', 'share', 'share/trm06', 'share/trm06/launcher.py')
              for mutation in ('positive', 'preserved-inode', 'copy', 'symlink', 'writable', 'owner')]
    result += [('launcher', leaf, mutation) for leaf in LEAVES
               for mutation in ('positive', 'preserved-inode', 'copy', 'symlink',
                                'writable', 'contents', 'hardlink', 'fifo', 'directory', 'canary', 'owner')]
    result += [('launcher', parent, mutation) for parent in PARENTS
               for mutation in ('positive', 'preserved-inode', 'copy', 'symlink', 'writable', 'owner')]
    result += [('shell', leaf, mutation) for leaf in LEAVES
               for mutation in ('positive', 'copy', 'symlink', 'writable', 'contents', 'hardlink', 'fifo', 'directory', 'canary', 'owner')
               if leaf != 'share/trm06/run.sh']
    result += [('shell', parent, mutation) for parent in PARENTS
               for mutation in ('positive', 'copy', 'symlink', 'writable', 'owner')]
    return result


def positive_control(phase, mutation):
    # A trusted identical copy installed before validation remains main-pinned.
    # Copies made after validation must refuse because held ancestry changed.
    return mutation == 'positive' or (phase == 'shell' and mutation == 'copy')


def protected(path):
    # lstat every component, including the final one: no resolved symlink can
    # select either a fixture, baseline or receipt from a member-owned tree.
    for current in reversed((path,) + tuple(path.parents)):
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('untrusted native fixture component')
    return path


def identity(path):
    info = protected(path).stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('untrusted native artifact')
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'mode': stat.S_IMODE(info.st_mode)}


def bundle_identity(root):
    manifest = json.loads(protected(root / 'manifest.json').read_bytes())
    files = {'manifest.json': identity(root / 'manifest.json')}
    for entry in manifest['files']:
        name = entry['path']
        if name in LEAVES[1:] or name == 'share/trm06/host_validation.py':
            actual = identity(root / name)
            if actual != {'sha256': entry['sha256'], 'mode': entry['mode']}:
                raise ValueError('native artifact digest/mode differs from manifest')
            files[name] = actual
    if set(files) != set(LEAVES) | {'share/trm06/host_validation.py'}:
        raise ValueError('native bundle incomplete')
    return {'revision': manifest['revision'], 'artifacts': files}


def sentinel():
    path = Path('/sentinel')
    info = path.lstat()
    if (path.read_bytes(), info.st_uid, info.st_mode) != (b'outside-fixture\0', 0, stat.S_IFREG | 0o644):
        raise ValueError('outside sentinel bytes/owner/mode changed')
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'uid': 0, 'mode': 0o644}


# This wrapper observes unchanged production code through the Python tracing
# API, then relinquishes privilege before bootstrap/launcher/gateway execution.
# The separate root worker performs only literal replacement fixtures.
WRAPPER = r'''
import os, sys, time, json, shutil
from pathlib import Path
request_r, request_w = os.pipe()
reply_r, reply_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(request_w); os.close(reply_r)
    if os.read(request_r, 1) != b'1': os._exit(2)
    start = time.monotonic_ns()
    path = Path(TARGET)
    if MUTATION in ('preserved-inode', 'copy', 'symlink', 'fifo', 'directory'):
        original = path.with_name(path.name + '-held')
        path.rename(original)
        if MUTATION == 'symlink': path.symlink_to(original)
        elif MUTATION == 'fifo': os.mkfifo(path)
        elif MUTATION == 'directory': path.mkdir()
        elif MUTATION == 'copy':
            if original.is_dir(): shutil.copytree(original, path)
            else: shutil.copy2(original, path)
        elif original.is_dir():
            path.mkdir()
            for child in original.iterdir(): child.rename(path / child.name)
        else: os.link(original, path)
    elif MUTATION == 'writable': path.chmod(0o777)
    elif MUTATION == 'owner': os.chown(path, 501, 501)
    elif MUTATION == 'contents': path.write_bytes(b'x' * path.stat().st_size)
    elif MUTATION == 'hardlink': os.link(path, '/hardlink')
    elif MUTATION == 'canary':
        path.write_bytes(b"#!/bin/sh\nprintf canary >> /sentinel\n"); path.chmod(0o755)
    end = time.monotonic_ns()
    Path('/race.json').write_text(json.dumps({'worker_pid': os.getpid(), 'worker_uid': os.geteuid(), 'start_ns': start, 'end_ns': end}))
    os.write(reply_w, b'1'); os._exit(0)
os.close(request_r); os.close(reply_w)
os.setgroups([]); os.setgid(501); os.setuid(501)
held = None
def trace(frame, event, arg):
    global held
    if event == 'line' and frame.f_code.co_filename == TRACE_FILE and frame.f_lineno == BARRIER and held is None:
        held = time.monotonic_ns()
        os.write(request_w, b'1')
        if os.read(reply_r, 1) != b'1': raise ValueError('mutation worker failed')
        _, status = os.waitpid(pid, 0)
        if status: raise ValueError('mutation worker failed')
        # Send timings through inherited stderr, not a member-writable file.
        sys.stderr.write('SCHEDULE ' + json.dumps({'held_ns': held, 'resume_ns': time.monotonic_ns()}) + '\n')
    return trace
sys.argv = ['bootstrap', 'check-startup']
sys.settrace(trace)
exec(compile(BOOTSTRAP, '<installed-bootstrap>', 'exec'), {'__name__': '__main__'})
'''


def control(phase, target, mutation, revision, index):
    script = (ROOT / 'share/trm06/run.sh').read_text()
    command = next(line.strip() for line in script.splitlines()
                   if '-c ' in line and line.rstrip().endswith(' check-startup'))
    tokens = shlex.split(command)
    bootstrap = tokens[tokens.index('-c') + 1]
    launcher = (ROOT / 'share/trm06/launcher.py').read_text()
    code = bootstrap if phase == 'bootstrap' else launcher
    marker = 'current = os.open("/"' if phase == 'bootstrap' else 'operation = sys.argv[1]'
    barrier = next(i for i, line in enumerate(code.splitlines(), 1) if line.strip().startswith(marker))
    path = ROOT if target == '.' else ROOT / target
    prefix = '\n'.join(name + '=' + repr(value) for name, value in {
        'TARGET': str(path), 'MUTATION': mutation, 'BARRIER': barrier,
        'TRACE_FILE': '<installed-bootstrap>' if phase == 'bootstrap' else str(ROOT / 'share/trm06/launcher.py'),
        'BOOTSTRAP': bootstrap}.items()) + '\n'
    wrapper = WRAPPER
    if phase == 'shell':
        entry = ROOT / ('share/trm06/revoke.sh' if target == 'share/trm06/run.sh' else 'share/trm06/run.sh')
        # For static replacement controls the worker completes before the actual
        # shell entry starts. Synchronized bootstrap/launcher controls above
        # retain their validation-to-recheck barrier separately.
        wrapper = wrapper[:wrapper.index("sys.argv = ['bootstrap'")] + r'''
held = time.monotonic_ns()
os.write(request_w, b'1')
if os.read(reply_r, 1) != b'1': raise ValueError('mutation worker failed')
_, status = os.waitpid(pid, 0)
if status: raise ValueError('mutation worker failed')
sys.stderr.write('SCHEDULE ' + json.dumps({'held_ns': held, 'resume_ns': time.monotonic_ns()}) + '\n')
os.execve('/bin/sh', ['/bin/sh', ENTRY, 'startup-validation'], {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'})
'''
        prefix += 'ENTRY=' + repr(str(entry)) + '\n'
    before = sentinel()
    process = subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-c', prefix + wrapper],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'}, cwd='/')
    observation = ''
    if positive_control(phase, mutation):
        output = bytearray()
        deadline = time.monotonic() + 10
        while len(output) <= 4096 and not output.endswith(b'\n'):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                process.kill(); process.wait()
                raise ValueError('installed startup sample timeout')
            byte = os.read(process.stdout.fileno(), 1)
            if not byte:
                break
            output.extend(byte)
        output = bytes(output)
        if not output.endswith(b'\n'):
            _, error = process.communicate(timeout=10)
            Path('/samples/' + str(index) + '.stdout').write_bytes(output)
            Path('/samples/' + str(index) + '.stderr').write_bytes(error)
            raise ValueError('installed startup sample missing')
        observation = subprocess.check_output(['/bin/ps', '-p', str(process.pid), '-o', 'pid=,uid=,command='],
                                              env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'}).decode()
        if len(observation.split()) < 3 or observation.split()[:2] != [str(process.pid), '501'] or 'check-startup' not in observation:
            process.kill(); process.wait()
            raise ValueError('independent gateway UID/command mismatch')
        tail, error = process.communicate(b'1', timeout=10)
        output += tail
    else:
        try:
            output, error = process.communicate(b'1', timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            output, error = process.communicate()
            Path('/samples/' + str(index) + '.stdout').write_bytes(output)
            Path('/samples/' + str(index) + '.stderr').write_bytes(error)
            raise ValueError('installed replacement timeout is not refusal')
    Path('/samples/' + str(index) + '.stdout').write_bytes(output)
    Path('/samples/' + str(index) + '.stderr').write_bytes(error)
    Path('/samples/' + str(index) + '.process').write_text(observation)
    lines = error.splitlines(keepends=True)
    if not lines or not lines[0].startswith(b'SCHEDULE '):
        raise ValueError('native schedule did not reach validation barrier: ' + repr(error))
    timings = json.loads(lines.pop(0)[9:])
    worker = json.loads(Path('/race.json').read_bytes())
    if not (worker['worker_pid'] > 0 and worker['worker_uid'] == 0 and
            0 < timings['held_ns'] <= worker['start_ns'] <= worker['end_ns'] <= timings['resume_ns']):
        raise ValueError('native schedule ordering mismatch')
    if positive_control(phase, mutation):
        sample = json.loads(output)
        if process.returncode != 0 or lines or sample != {
                'pid': process.pid, 'revision': revision,
                'environment': ['PATH=/usr/bin:/bin:/usr/sbin:/sbin']}:
            raise ValueError('installed gateway positive failed')
    elif process.returncode != 78 or output or b''.join(lines) != REFUSAL:
        raise ValueError('replacement did not explicitly refuse')
    after = sentinel()
    return dict(phase=phase, target=target, mutation=mutation, status='pass',
                exit=process.returncode, stdout=output.decode(), stderr=error.decode(),
                before=before, after=after, process=observation, **timings, **worker)


def verify_receipt(receipt, expected):
    if receipt.get('identity') != expected or receipt.get('platform') != 'darwin-arm64':
        raise ValueError('native host receipt identity mismatch')
    samples = receipt['samples']
    if len(samples) != len(schedules()):
        raise ValueError('native host receipt incomplete')
    for sample, selector in zip(samples, schedules()):
        if tuple(sample[k] for k in ('phase', 'target', 'mutation')) != selector or sample['status'] != 'pass':
            raise ValueError('native host schedule missing or failed')
        outside = {'sha256': hashlib.sha256(b'outside-fixture\0').hexdigest(), 'uid': 0, 'mode': 0o644}
        if sample['before'] != outside or sample['after'] != outside or sample['worker_uid'] != 0 or sample['worker_pid'] <= 0:
            raise ValueError('native sentinel/worker mismatch')
        if not 0 < sample['held_ns'] <= sample['start_ns'] <= sample['end_ns'] <= sample['resume_ns']:
            raise ValueError('native timing mismatch')
        if positive_control(selector[0], selector[2]):
            observed = json.loads(sample['stdout'])
            if sample['exit'] != 0 or observed['revision'] != expected['revision'] or observed['environment'] != ['PATH=/usr/bin:/bin:/usr/sbin:/sbin']:
                raise ValueError('native positive receipt mismatch')
            if len(sample['process'].split()) < 3 or sample['process'].split()[:2] != [str(observed['pid']), '501'] or 'check-startup' not in sample['process']:
                raise ValueError('native independent identity missing')
        elif sample['exit'] != 78 or sample['stdout'] or not sample['stderr'].endswith(REFUSAL.decode()):
            raise ValueError('native refusal receipt mismatch')
    if receipt['status'] != 'pass' or receipt['accepted'] is not False:
        raise ValueError('native host receipt cannot grant acceptance')


def main():
    expected = bundle_identity(ROOT)
    if sys.argv[1:] == ['--read']:
        if sys.platform != 'darwin' or platform.machine() != 'arm64':
            raise ValueError('native host receipt reader required')
        receipt = json.loads(protected(RECEIPT).read_bytes())
        verify_receipt(receipt, expected)
        print(json.dumps(receipt))
        return
    if sys.argv[1:] or sys.platform != 'darwin' or platform.machine() != 'arm64' or os.geteuid() != 0:
        raise ValueError('native disposable root fixture required')
    protected(FIXTURE)
    if bundle_identity(FIXTURE / 'trm06-baseline') != expected:
        raise ValueError('native baseline differs from installed bundle')
    receipt = {'identity': expected, 'platform': 'darwin-arm64', 'status': 'NO', 'accepted': False, 'samples': []}
    evidence = FIXTURE / 'samples'
    evidence.mkdir(mode=0o700)
    for index, selector in enumerate(schedules()):
        pid = os.fork()
        if pid == 0:
            try:
                os.chroot(FIXTURE); os.chdir('/')
                # Each case uses a disposable fixture clone, never live bytes.
                if ROOT.exists(): shutil.rmtree(ROOT)
                shutil.copytree('/trm06-baseline', ROOT)
                Path('/sentinel').write_bytes(b'outside-fixture\0'); Path('/sentinel').chmod(0o644)
                # Prove the literal canary executes before absence is used.
                subprocess.run(['/bin/sh', '-c', 'printf canary >> /sentinel'], check=True)
                if Path('/sentinel').read_bytes() != b'outside-fixture\0canary':
                    raise ValueError('native canary positive failed')
                Path('/sentinel').write_bytes(b'outside-fixture\0')
                target = ROOT if selector[1] == '.' else ROOT / selector[1]
                saved_mode = stat.S_IMODE(target.stat().st_mode)
                try:
                    sample = control(*selector, expected['revision'], index)
                finally:
                    held = target.with_name(target.name + '-held')
                    if held.exists():
                        if selector[2] == 'preserved-inode' and held.is_dir():
                            for child in target.iterdir(): child.rename(held / child.name)
                        if target.is_symlink() or not target.is_dir(): target.unlink()
                        else: shutil.rmtree(target)
                        held.rename(target)
                    elif selector[2] == 'writable': target.chmod(saved_mode)
                    elif selector[2] == 'owner': os.chown(target, 0, 0)
                    if Path('/hardlink').exists(): Path('/hardlink').unlink()
                Path('/samples/' + str(index) + '.json').write_text(json.dumps(sample))
                os._exit(0)
            except BaseException as error:
                Path('/samples/' + str(index) + '.json').write_text(json.dumps({'status': 'NO', 'failure': repr(error), 'selector': selector}))
                os._exit(1)
        _, status = os.waitpid(pid, 0)
        sample = json.loads((evidence / (str(index) + '.json')).read_bytes())
        receipt['samples'].append(sample)
        if status:
            break
    if len(receipt['samples']) == len(schedules()) and all(s['status'] == 'pass' for s in receipt['samples']):
        receipt['status'] = 'pass'
    # Exclusive publication refuses stale evidence; the owner retains/removes
    # an old receipt explicitly before rerunning the disposable campaign.
    with RECEIPT.open('x') as output:
        os.chmod(RECEIPT, 0o644)
        json.dump(receipt, output)
    verify_receipt(receipt, expected)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'NO', 'accepted': False, 'failure': str(error)}), file=sys.stderr)
        sys.exit(78)
