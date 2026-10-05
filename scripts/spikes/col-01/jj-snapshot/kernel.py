#!/usr/bin/env python3
"""Probe Linux filesystem semantics as the guest agent; never elevate."""
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import tempfile


class OpenHow(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64),
                ('resolve', ctypes.c_uint64)]


def probe(repo):
    if os.geteuid() != 19999 or platform.system() != 'Linux':
        raise ValueError('kernel probes require Linux guest agent uid 19999')
    arch = platform.machine()
    if arch not in ['aarch64', 'x86_64']:
        raise ValueError('unreviewed syscall numbers for architecture')
    libc = ctypes.CDLL(None, use_errno=True)
    syscall = libc.syscall
    syscall.restype = ctypes.c_long
    rename_nr = 276 if arch == 'aarch64' else 316
    results = {}
    with tempfile.TemporaryDirectory(prefix='col11-kernel-', dir=repo) as directory:
        root = Path(directory)
        (root / 'a').write_bytes(b'A')
        (root / 'b').write_bytes(b'B')
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            rc = syscall(rename_nr, fd, ctypes.c_char_p(b'a'), fd,
                         ctypes.c_char_p(b'b'), 2)  # RENAME_EXCHANGE
            results['renameat2_exchange'] = {'yes': rc == 0 and
                (root / 'a').read_bytes() == b'B' and (root / 'b').read_bytes() == b'A',
                'errno': ctypes.get_errno() if rc < 0 else 0}
            before = [(root / name).read_bytes() for name in ['a', 'b']]
            rc = syscall(rename_nr, fd, ctypes.c_char_p(b'a'), fd,
                         ctypes.c_char_p(b'b'), 1)  # RENAME_NOREPLACE
            results['renameat2_noreplace'] = {'yes': rc == -1 and
                ctypes.get_errno() == errno.EEXIST and before ==
                [(root / name).read_bytes() for name in ['a', 'b']],
                'errno': ctypes.get_errno() if rc < 0 else 0}
            how = OpenHow(os.O_RDONLY | os.O_CLOEXEC, 0, 8)  # RESOLVE_BENEATH
            opened = syscall(437, fd, ctypes.c_char_p(b'a'), ctypes.byref(how), ctypes.sizeof(how))
            readable = opened >= 0
            if readable:
                readable = os.read(opened, 1) == (root / 'a').read_bytes()
                os.close(opened)
            os.symlink('/etc/passwd', root / 'escape')
            escaped = syscall(437, fd, ctypes.c_char_p(b'escape'), ctypes.byref(how), ctypes.sizeof(how))
            escape_errno = ctypes.get_errno()
            if escaped >= 0:
                os.close(escaped)
            results['openat2_beneath'] = {'yes': readable and escaped < 0 and escape_errno == errno.EXDEV,
                                         'escape_errno': escape_errno}
        finally:
            os.close(fd)
    # File existence is not evidence that freeze/kill works. A root helper is
    # deliberately not created or invoked from repository-controlled bytes.
    for name in ['cgroup.freeze', 'cgroup.kill']:
        results[name] = {'status': 'blocked', 'reason': 'reviewed main-pinned privileged probe helper required'}
    return {'uid': os.geteuid(), 'kernel': platform.release(), 'architecture': arch,
            'filesystem': str(Path(repo).resolve()), 'probes': results,
            'complete': False}


if __name__ == '__main__':
    import sys
    output = Path(sys.argv[2])
    if output.exists():
        raise ValueError('refusing stale kernel evidence')
    output.write_text(json.dumps(probe(sys.argv[1]), indent=2) + '\n')
    raise SystemExit(2)  # No passing receipt while privileged probes are blocked.
