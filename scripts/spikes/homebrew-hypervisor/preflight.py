"""Disposable C-SPK-06 input inventory. Never executes a VM or supplies a receipt.

Approval is read from local main, never from the lane or caller's environment.
This deliberately stops at the dependency boundary until release inputs exist.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

APPROVAL = 'distribution/homebrew-spike-approved.json'
IMAGE = 'node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b'
REQUIRED = ('bin/msb', 'bin/smithers-backend', 'lib/libkrunfw.5.dylib',
            'share/microsandbox/base-image.oci.tar', 'share/microsandbox/base-image.json')


def digest(path):
    with path.open('rb') as stream:
        value = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
        return value.hexdigest()


def git(root, *args):
    return subprocess.check_output(['/usr/bin/git', '-C', str(root), *args],
                                   stderr=subprocess.PIPE).decode().strip()


def validate(root, bundle):
    # A hash supplied by the caller does not authorize branch-built root code.
    approval = json.loads(git(root, 'show', 'refs/heads/main:' + APPROVAL))
    if approval.get('version') != 1 or approval.get('image') != IMAGE:
        raise ValueError('main approval version/image mismatch')
    if approval.get('acceptedBy') != ['smithers-3f', 'smithers-b8']:
        raise ValueError('signing/security and packaging acceptance missing')
    revision = approval['revision']
    if len(revision) != 40 or any(c not in '0123456789abcdef' for c in revision):
        raise ValueError('invalid approved backend revision')
    git(root, 'merge-base', '--is-ancestor', revision, 'refs/heads/main')
    manifest_path = bundle / 'manifest.json'
    if manifest_path.is_symlink() or digest(manifest_path) != approval['manifestSHA256']:
        raise ValueError('unapproved manifest')
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get('version'), manifest.get('platform'), manifest.get('revision')) != (1, 'darwin-arm64', revision):
        raise ValueError('bundle identity mismatch')
    entries = manifest['files']
    declared = {entry['path']: entry for entry in entries}
    if len(declared) != len(entries):
        raise ValueError('duplicate manifest path')
    actual = set()
    for path in bundle.rglob('*'):
        if path.is_symlink():
            raise ValueError('symlinks require a separately reviewed inventory')
        if path.is_file() and path != manifest_path:
            actual.add(path.relative_to(bundle).as_posix())
    if actual != set(declared):
        raise ValueError('bundle file inventory mismatch')
    for name, entry in declared.items():
        path = bundle / name
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('unsafe manifest path')
        if digest(path) != entry['sha256'] or (path.stat().st_mode & 0o777) != entry['mode']:
            raise ValueError('bundle hash/mode mismatch: ' + name)
    if not set(REQUIRED).issubset(declared):
        raise ValueError('required root input missing')
    if json.loads((bundle / REQUIRED[-1]).read_text()).get('image') != IMAGE:
        raise ValueError('branch image refused')
    return {'backend_commit': revision, 'manifest_sha256': digest(manifest_path),
            'image': IMAGE, 'artifacts': {name: digest(bundle / name) for name in REQUIRED}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True)
    args = parser.parse_args()
    try:
        # Never forward an inherited VM/loader environment, even for a positive control.
        forbidden = [key for key in os.environ if key.startswith(('MSB_', 'DYLD_', 'LD_'))
                     or key.startswith('SMITHERS_')]
        if forbidden:
            raise ValueError('inherited guest/runtime environment refused: ' + ','.join(sorted(forbidden)))
        root = Path(__file__).resolve().parents[3]
        bundle = Path(args.bundle).resolve(strict=True)
        inventory = validate(root, bundle)
        print(json.dumps({'status': 'inputs-verified', 'vm_commands': 0, **inventory}, sort_keys=True))
        # No alternate runner or invented passing check receipt. The existing
        # check-run runner needs a reviewed reference-host binding first.
        raise ValueError('qualification blocked: fresh-user install/pour, GUI login/relocation evidence and approved C-SPK-06 reference-host binding required')
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(json.dumps({'status': 'refused', 'vm_commands': 0, 'reason': str(error)}, sort_keys=True))
        return 2


if __name__ == '__main__':
    sys.exit(main())
