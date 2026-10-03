#!/usr/bin/env python3
"""Provision only this disposable VM, through its existing host bridge."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

root = Path('/workspace')
proxy = sys.argv[1]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': proxy}))


def download(url, destination, algorithm, expected):
    digest = hashlib.new(algorithm)
    with opener.open(url, timeout=120) as source, destination.open('wb') as output:
        while data := source.read(1024 * 1024):
            output.write(data)
            digest.update(data)
    if digest.digest() != expected:
        raise RuntimeError(f'digest mismatch: {url}')


store_archive = root / 'snapshot-store.tar'
if not store_archive.is_file():
    raise RuntimeError('snapshot blocked: complete Linux ARM64 pnpm store archive required')
store = root / 'snapshot-store'
store.mkdir()
with tarfile.open(store_archive) as archive:
    archive.extractall(store, filter='data')
store_digest = hashlib.sha256(store_archive.read_bytes()).hexdigest()
store_archive.unlink()

node = root / 'snapshot-node' 
node.mkdir()
tar = root / 'snapshot-node.tar.gz'
download('https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-arm64.tar.gz', tar,
         'sha256', bytes.fromhex('308e5fe89a82461ba5a6cf15ff5221b2cdbd7ae87600aa72bb3c3fbdc66412d1'))
with tarfile.open(tar) as archive:
    archive.extractall(node, filter='data')
tar.unlink()
pnpm = root / 'snapshot-pnpm'
pnpm.mkdir()
with opener.open('https://registry.npmjs.org/pnpm/11.25.0', timeout=120) as response:
    package = json.load(response)
algorithm, integrity = package['dist']['integrity'].split('-', 1)
tar = root / 'snapshot-pnpm.tar.gz'
download(package['dist']['tarball'], tar, algorithm, base64.b64decode(integrity))
with tarfile.open(tar) as archive:
    archive.extractall(pnpm, filter='data')
tar.unlink()
env = dict(os.environ, HTTPS_PROXY=proxy, https_proxy=proxy, HTTP_PROXY=proxy,
           http_proxy=proxy, CI='1')
env['PATH'] = str(node / 'node-v26.5.0-linux-arm64/bin') + ':' + env['PATH']
repo = root / 'snapshot-repo'
subprocess.run([str(root / 'col01-jj'), 'git', 'clone', '--no-colocate', '--depth',
                '1', '--fetch-tags', 'none', '--branch', 'main',
                'https://github.com/smithersai/smithers.git', str(repo)], env=env, check=True)
subprocess.run(['node', str(pnpm / 'package/bin/pnpm.cjs'), 'install',
                '--frozen-lockfile', '--offline', '--store-dir', str(store)], cwd=repo, env=env, check=True)
receipt = {'repository': 'https://github.com/smithersai/smithers.git',
           'store_archive_sha256': store_digest, 'dependency_install': 'offline',
           'depth': 1, 'branch': 'main', 'pnpm': package['version'],
           'pnpm_integrity': package['dist']['integrity'],
           'node': subprocess.check_output(['node', '--version'], env=env, text=True).strip(),
           'revision': subprocess.check_output([str(root / 'col01-jj'), 'log',
                     '--ignore-working-copy', '-r', 'main@origin', '--no-graph',
                     '-T', 'commit_id'], cwd=repo, env=env, text=True).strip()}
(root / 'snapshot-prepare.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('SNAPSHOT PREPARED', json.dumps(receipt), flush=True)
