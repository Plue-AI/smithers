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
CYCLES = 3
DAILY_CAPTURES = 5760
CADENCE_SECONDS = 5
DAY_SECONDS = 86400
KEEP_OPERATIONS = 100
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


def retention_budget(cycles):
    if len(cycles) != CYCLES or any(c['captures'] != DAILY_CAPTURES for c in cycles):
        raise ValueError('three complete daily cycles required')
    peak = max(sum(c['before_cleanup'].values()) for c in cycles)
    residue = max(0, *(sum(cycles[i]['after_cleanup'].values()) -
                       sum(cycles[i - 1]['after_cleanup'].values())
                       for i in range(1, CYCLES)))
    return {'peak_bytes': peak, 'largest_residue_bytes': residue,
            'projected_14_day_bytes': peak + 14 * residue,
            'growth_budget_passed': peak + 14 * residue < LIMIT}


def cleanup(fixture, output, cycle):
    # jj operation timestamps are kernel-clock observations, never synthetic age.
    log = fixture.command('op', 'log', '--no-graph', '--template',
                          'id ++ " " ++ time.end().format("%s") ++ "\\n"',
                          ignore_working_copy=True).stdout
    (output / f'operations-{cycle}.log').write_bytes(log)
    entries = [line.split() for line in log.decode().splitlines()]
    cutoff = time.time() - DAY_SECONDS
    boundary = None
    # Retain the newest 100 and every operation within the last 24 hours.
    for index, (oid, ended) in enumerate(entries):
        if len(oid) != 128 or any(c not in '0123456789abcdef' for c in oid):
            raise ValueError('invalid operation identity')
        if index < KEEP_OPERATIONS or int(ended) >= cutoff:
            boundary = oid
    if boundary is None:
        raise ValueError('missing retained operation boundary')
    abandoned = fixture.command('op', 'abandon', '..' + boundary, ignore_working_copy=True)
    with (output / 'abandon.log').open('ab') as stream:
        stream.write(f'cycle={cycle} cutoff={cutoff} boundary={boundary}\n'.encode())
        stream.write(abandoned.stdout + abandoned.stderr)
    gc = fixture.command('util', 'gc', '--expire', 'now', ignore_working_copy=True)
    with (output / 'gc.log').open('ab') as stream:
        stream.write(f'cycle={cycle}\n'.encode() + gc.stdout + gc.stderr)
    fixture.verify()


def wait_until(deadline):
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(30, remaining))


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
        cycles = []
        campaign_start = time.monotonic()
        with (output / 'cycles.csv').open('x', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['cycle', 'capture', 'unix_seconds', 'snapshot_ns', 'jj_bytes', 'git_bytes'])
            for cycle in range(CYCLES):
                wait_until(campaign_start + cycle * DAY_SECONDS)
                started = time.monotonic()
                for seq in range(DAILY_CAPTURES):
                    wait_until(started + seq * CADENCE_SECONDS)
                    fixture.prepare(12)
                    elapsed = fixture.snapshot()
                    current = sizes(fixture.repo)
                    writer.writerow([cycle + 1, seq + 1, time.time(), elapsed,
                                     current['.jj'], current['.git']])
                    stream.flush()
                    fixture.verify()
                    if time.monotonic() > started + (seq + 1) * CADENCE_SECONDS:
                        raise ValueError('capture missed the five-second cadence')
                wait_until(started + DAILY_CAPTURES * CADENCE_SECONDS)
                pre = sizes(fixture.repo)
                cleanup(fixture, output, cycle + 1)
                cycles.append({'cycle': cycle + 1, 'captures': DAILY_CAPTURES,
                               'before_cleanup': pre, 'after_cleanup': sizes(fixture.repo)})
                (output / 'cycles.json').write_text(json.dumps(cycles, indent=2) + '\n')
        reclaimed = sizes(fixture.repo)
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
        budget = retention_budget(cycles)
        result = {'uid': os.geteuid(), 'repo': str(fixture.repo), 'captures': CAPTURES,
                  'before': before, 'after': after, 'after_gc': reclaimed,
                  'reclaimed_bytes': sum(after.values()) - sum(reclaimed.values()),
                  'cycles': cycles, **budget,
                  'versions': summary(values), 'jj_sha256': hashlib.sha256(Path(fixture.jj).read_bytes()).hexdigest(),
                  'git_version': subprocess.check_output(['git', '--version'], text=True).strip(),
                  'limitations': 'Allocated bytes, warm caches, 128-byte fixture files. Synthetic 12-blob flat-tree parentless versions workload; not the full before/after tree builder. Budget uses three measured daily cycles and post-cleanup residue; not a retention policy approval.'}
        (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
        return 0 if result['growth_budget_passed'] else 3
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
