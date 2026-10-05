#!/usr/bin/env python3
"""Guest-only COL-11 storage and versions observations, following snapshot.py."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from snapshot import Repository, summary

CAPTURES = 1000
VERSIONS = 100
PROJECTED_CAPTURES = 14 * 8 * 60 * 60 // 5
LIMIT = 2 * 1024 ** 3


def sizes(repo):
    # Count allocated bytes once, without following symlinks. Non-colocated
    # jj's Git store is already included under .jj; absent .git is zero.
    def allocated(root):
        if not root.exists():
            return 0
        return root.lstat().st_blocks * 512 + sum(
            p.lstat().st_blocks * 512 for p in root.rglob('*'))
    return {name: allocated(repo / name) for name in ['.jj', '.git']}


def projection(before, after):
    growth = max(0, sum(after.values()) - sum(before.values()))
    return (growth * PROJECTED_CAPTURES + CAPTURES - 1) // CAPTURES


def git(repo, *args, data=None):
    store = repo / '.jj/repo/store/git'
    if not store.is_dir():
        raise ValueError('expected non-colocated Git-backed jj store')
    return subprocess.run(['git', '--git-dir', str(store), *args], input=data,
                          capture_output=True, check=True, timeout=120).stdout


def versions(repo, files):
    start = time.perf_counter_ns()
    entries = []
    for path in files:
        oid = git(repo, 'hash-object', '-w', '--stdin', data=path.read_bytes()).strip()
        entries.append(b'100644 blob ' + oid + b'\t' + path.name.encode() + b'\n')
    tree = git(repo, 'mktree', data=b''.join(entries)).strip().decode()
    commit = git(repo, '-c', 'user.name=COL11', '-c', 'user.email=col11@example.invalid',
                 'commit-tree', tree,
                 data=b'COL11 versions burst\n').strip().decode()
    git(repo, 'update-ref', 'refs/smithers/versions/col11-spike', commit)
    elapsed = time.perf_counter_ns() - start
    # Validation is outside the measured burst and reads the stored objects.
    for path in files:
        if git(repo, 'show', commit + ':' + path.name) != path.read_bytes():
            raise ValueError('versions commit content mismatch')
    return elapsed, commit


def measure(repo, output, jj):
    if os.geteuid() != 19999 or not Path('/proc/self/status').is_file():
        raise ValueError('measurement requires Linux guest agent uid 19999')
    output.mkdir(parents=True, exist_ok=False)
    try:
        fixture = Repository(repo, jj)
        fixture.expected = [p.read_bytes() for p in fixture.files]
        # Continue monotonically after snapshot.py, without reusing fixture bytes.
        fixture.generation = max(int(b.split(b'generation=')[1].split(b';')[0])
                                 for b in fixture.expected)
        fixture.verify()
        before = sizes(fixture.repo)
        with (output / 'growth.csv').open('x', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['capture', 'snapshot_ns', 'jj_bytes', 'git_bytes'])
            for seq in range(CAPTURES):
                fixture.prepare(12)
                elapsed = fixture.snapshot()
                current = sizes(fixture.repo)
                writer.writerow([seq + 1, elapsed, current['.jj'], current['.git']])
                stream.flush()
                fixture.verify()
        after = sizes(fixture.repo)
        abandon = fixture.command('op', 'abandon', '..@' + '-' * 100, ignore_working_copy=True)
        (output / 'abandon.log').write_bytes(abandon.stdout + abandon.stderr)
        # Expire unreachable objects now rather than jj's default grace period.
        gc = fixture.command('util', 'gc', '--expire', 'now', ignore_working_copy=True)
        (output / 'gc.log').write_bytes(gc.stdout + gc.stderr)
        reclaimed = sizes(fixture.repo)
        fixture.verify()
        values = []
        with (output / 'versions.csv').open('x', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['burst', 'elapsed_ns', 'commit'])
            for seq in range(VERSIONS):
                fixture.prepare(12)
                elapsed, commit = versions(fixture.repo, fixture.files[:12])
                writer.writerow([seq + 1, elapsed, commit])
                stream.flush()
                values.append(elapsed)
        estimate = projection(before, after)
        result = {'uid': os.geteuid(), 'repo': str(fixture.repo), 'captures': CAPTURES,
                  'before': before, 'after': after, 'after_gc': reclaimed,
                  'reclaimed_bytes': sum(after.values()) - sum(reclaimed.values()),
                  'projected_14_day_bytes': estimate, 'growth_budget_passed': estimate < LIMIT,
                  'versions': summary(values), 'jj_sha256': hashlib.sha256(Path(fixture.jj).read_bytes()).hexdigest(),
                  'git_version': subprocess.check_output(['git', '--version'], text=True).strip(),
                  'limitations': 'Allocated bytes, warm caches, 128-byte fixture files. Synthetic 12-blob flat-tree parentless versions workload; not the full before/after tree builder. Projection is gross pre-GC growth; not a retention policy approval.'}
        (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
        return 0 if result['growth_budget_passed'] else 1
    except BaseException as error:
        failure = {'error': str(error)}
        if isinstance(error, subprocess.CalledProcessError):
            failure.update(command=error.cmd, returncode=error.returncode,
                           stderr=(error.stderr or b'').decode(errors='replace'))
        (output / 'failure.json').write_text(json.dumps(failure) + '\n')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('repo', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--jj', required=True)
    args = parser.parse_args()
    raise SystemExit(measure(args.repo, args.output, args.jj))
