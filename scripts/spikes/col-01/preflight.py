"""Refuse branch-produced runtime inputs before building or starting a VM."""
import json
import os
import platform
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
    forbidden = {'SPIKE_MSB_BIN', 'SPIKE_IMAGE', 'SPIKE_TOOLCHAIN',
                 'SPIKE_ROOT_HELPER', 'SPIKE_PLIST', 'PYTHONPATH', 'PYTHONHOME',
                 'GOFLAGS', 'GOENV', 'RUSTC_WRAPPER', 'RUSTUP_TOOLCHAIN'}
    overrides = sorted(forbidden.intersection(os.environ))
    if overrides:
        raise ValueError('unreviewed root/toolchain input: ' + ', '.join(overrides))
    if os.geteuid() == 0:
        raise ValueError('host measurement must run as non-root')
    directory = 'packages/backend'
    entries = git('ls-tree', '-r', '-z', approved, '--', directory).split(b'\0')
    expected = {}
    for entry in filter(None, entries):
        metadata, path = entry.split(b'\t', 1)
        name = path.decode()
        if measurement_only(name):
            continue
        mode, kind, blob = metadata.decode().split()
        if mode not in ['100644', '100755'] or kind != 'blob':
            raise ValueError('unreviewed runtime input type: ' + name)
        expected[name] = blob
    for entry in filter(None, git('ls-tree', '-r', '-z', approved, '--',
                                  'go.mod', 'go.sum', 'go.work', 'go.work.sum',
                                  'rust-toolchain.toml', '.cargo/config.toml',
                                  'package.json', 'pnpm-lock.yaml', '.npmrc').split(b'\0')):
        metadata, path = entry.split(b'\t', 1)
        mode, kind, blob = metadata.decode().split()
        if mode not in ['100644', '100755'] or kind != 'blob':
            raise ValueError('unreviewed build input type: ' + path.decode())
        expected[path.decode()] = blob
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
    # Host code must itself be reviewed main, including build recipes and probes.
    harness = 'scripts/spikes/col-01'
    for entry in filter(None, git('ls-tree', '-r', '-z', approved, '--', harness).split(b'\0')):
        metadata, raw_name = entry.split(b'\t', 1)
        name = raw_name.decode()
        if measurement_only(name) or name.endswith('.py') and '/test_' in name:
            continue
        mode, kind, blob = metadata.decode().split()
        path = root / name
        if mode not in ['100644', '100755'] or kind != 'blob' or path.is_symlink() or not path.is_file():
            raise ValueError('unreviewed host measurement input: ' + name)
        if path.read_bytes() != git('cat-file', 'blob', blob):
            raise ValueError('branch-produced host measurement input: ' + name)
        expected[name] = blob
    for path in (root / harness).rglob('*'):
        if path.is_dir() and not path.is_symlink():
            continue
        name = path.relative_to(root).as_posix()
        if any(part in ['node_modules', '__pycache__'] for part in path.parts):
            continue
        if not measurement_only(name) and not path.name.startswith('test_') and name not in expected:
            raise ValueError('unreviewed extra host measurement input: ' + name)
    return {'main_pinned_runtime_commit': approved, 'runtime_inputs': expected,
            'host_uid': os.geteuid()}



if __name__ == '__main__':
    try:
        inventory = verify(Path(sys.argv[1]).resolve())
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise ValueError('reference Apple Silicon host isolation unavailable; no host fallback')
        print(json.dumps(inventory, sort_keys=True))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('SPIKE SECURITY BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(2)
