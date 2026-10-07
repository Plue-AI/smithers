"""Refuse branch-produced runtime inputs before building or starting a VM."""
import json
from pathlib import Path
import subprocess
import sys


def measurement_only(name):
    return name.endswith(('_test.go', '.md'))


def verify(root):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)

    # No caller-selected manifest or revision can bless its own root inputs.
    approved = git('rev-parse', '--verify', 'origin/main^{commit}').decode().strip()
    directory = 'packages/backend/microsandbox'
    entries = git('ls-tree', '-r', '-z', approved, '--', directory).split(b'\0')
    expected = {}
    for entry in filter(None, entries):
        metadata, path = entry.split(b'\t', 1)
        name = path.decode()
        if measurement_only(name):
            continue
        mode, kind, blob = metadata.decode().split()
        if mode != '100644' or kind != 'blob':
            raise ValueError('unreviewed runtime input type: ' + name)
        expected[name] = blob
    if not expected:
        raise ValueError('main-pinned runtime inventory missing')
    for name, blob in expected.items():
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('missing or symlinked runtime input: ' + name)
        if path.read_bytes() != git('cat-file', 'blob', blob):
            raise ValueError('branch-produced runtime input: ' + name)
    for path in (root / directory).rglob('*'):
        if path.is_dir() and not path.is_symlink():
            continue
        name = path.relative_to(root).as_posix()
        if not measurement_only(name) and name not in expected:
            raise ValueError('unreviewed extra runtime input: ' + name)
    return {'main_pinned_runtime_commit': approved, 'runtime_inputs': expected}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(Path(sys.argv[1]).resolve()), sort_keys=True))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('SPIKE SECURITY BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(2)
