#!/usr/bin/env python3
"""Guest-only COL-11 storage and versions observations, following snapshot.py."""
import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
from snapshot import Repository, summary

CAPTURES = 1000
VERSIONS = 100
PROJECTED_CAPTURES = 14 * 8 * 60 * 60 // 5
LIMIT = 2 * 1024 ** 3
DAILY_CAPTURES = 5760
DAY_SECONDS = 86400
CADENCE_SECONDS = 5


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


def retention_bound(cycles):
    """Bound measured retention, without crediting pre-existing garbage."""
    if len(cycles) != 3:
        raise ValueError('three daily cycles required')
    for index, cycle in enumerate(cycles):
        if any(not isinstance(cycle[key], (int, float)) or not math.isfinite(cycle[key])
               for key in ['start_epoch', 'end_epoch']):
            raise ValueError('invalid cycle timestamps')
        if cycle['captures'] != DAILY_CAPTURES:
            raise ValueError('5760 captures per cycle required')
        if cycle['end_epoch'] - cycle['start_epoch'] < DAILY_CAPTURES * CADENCE_SECONDS:
            raise ValueError('eight-hour cadence required')
        for key in ['before', 'after', 'after_gc']:
            if set(cycle[key]) != {'.jj', '.git'} or any(
                    type(n) is not int or n < 0 for n in cycle[key].values()):
                raise ValueError('invalid allocated storage sizes')
        if index and cycle['start_epoch'] - cycles[index - 1]['start_epoch'] < DAY_SECONDS:
            raise ValueError('daily cycles must start at least 24 hours apart')
    residues = [max(0, sum(cycles[i]['after_gc'].values()) -
                       sum(cycles[i - 1]['after_gc'].values())) for i in [1, 2]]
    peak = max(sum(c['after'].values()) for c in cycles)
    bound = peak + 14 * max(residues)
    return {'peak_pre_cleanup_bytes': peak, 'residue_bytes': residues,
            'projected_14_day_bytes': bound, 'growth_budget_passed': bound < LIMIT}


def cleanup_daily(fixture, output, cycle):
    # Read operation timestamps from jj, not capture-driver guesses. Keep all
    # operations younger than 24 hours AND at least the newest 100.
    inventory = fixture.command('op', 'log', '--no-graph', '--template',
        'id ++ "\\t" ++ time.end().format("%s") ++ "\\n"',
        ignore_working_copy=True).stdout
    (output / f'cycle-{cycle}-operations.tsv').write_bytes(inventory)
    operations = [(oid, int(epoch)) for oid, epoch in
                  (line.split('\t') for line in inventory.decode().splitlines())]
    if not operations or any(len(oid) != 128 or any(c not in '0123456789abcdef' for c in oid)
                             for oid, _ in operations):
        raise ValueError('invalid operation inventory')
    if any(a[1] < b[1] for a, b in zip(operations, operations[1:])):
        raise ValueError('nonlinear or unordered operation inventory')
    cutoff = int(time.time()) - DAY_SECONDS
    first_old = next((i for i, (_, epoch) in enumerate(operations)
                      if i >= 100 and epoch < cutoff), None)
    if first_old is not None:
        kept = operations[first_old - 1][0]
        abandon = fixture.command('op', 'abandon', '..' + kept, ignore_working_copy=True)
        log = abandon.stdout + abandon.stderr
    else:
        log = b'No operations older than 24 hours outside newest 100.\n'
    (output / f'cycle-{cycle}-abandon.log').write_bytes(log)
    gc = fixture.command('util', 'gc', '--expire', 'now', ignore_working_copy=True)
    (output / f'cycle-{cycle}-gc.log').write_bytes(gc.stdout + gc.stderr)
    fixture.verify()


def daily_cycles(fixture, output):
    cycles = []
    campaign_start = time.monotonic()
    with (output / 'retention-samples.csv').open('x', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['cycle', 'capture', 'epoch', 'snapshot_ns', 'jj_bytes', 'git_bytes'])
        for cycle in range(3):
            time.sleep(max(0, campaign_start + cycle * DAY_SECONDS - time.monotonic()))
            start = time.monotonic()
            row = {'start_epoch': time.time(), 'before': sizes(fixture.repo),
                   'captures': DAILY_CAPTURES}
            for seq in range(DAILY_CAPTURES):
                time.sleep(max(0, start + seq * CADENCE_SECONDS - time.monotonic()))
                if time.monotonic() - (start + seq * CADENCE_SECONDS) >= CADENCE_SECONDS:
                    raise ValueError('capture cadence missed; no catch-up burst permitted')
                fixture.prepare(12)
                elapsed = fixture.snapshot()
                current = sizes(fixture.repo)
                writer.writerow([cycle + 1, seq + 1, time.time(), elapsed,
                                 current['.jj'], current['.git']])
                stream.flush()
                fixture.verify()
            time.sleep(max(0, start + DAILY_CAPTURES * CADENCE_SECONDS - time.monotonic()))
            row.update(end_epoch=time.time(), after=sizes(fixture.repo))
            cleanup_daily(fixture, output, cycle + 1)
            row['after_gc'] = sizes(fixture.repo)
            cycles.append(row)
            (output / 'retention-cycles.json').write_text(json.dumps(cycles, indent=2) + '\n')
    return {'cycles': cycles, **retention_bound(cycles)}


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


def measure(repo, output, jj, retention=False):
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
        campaign = daily_cycles(fixture, output) if retention else None
        estimate = projection(before, after)
        result = {'uid': os.geteuid(), 'repo': str(fixture.repo), 'captures': CAPTURES,
                  'before': before, 'after': after, 'after_gc': reclaimed,
                  'reclaimed_bytes': sum(after.values()) - sum(reclaimed.values()),
                  'projected_14_day_bytes': estimate, 'growth_budget_passed': estimate < LIMIT,
                  'versions': summary(values), 'jj_sha256': hashlib.sha256(Path(fixture.jj).read_bytes()).hexdigest(),
                  'git_version': subprocess.check_output(['git', '--version'], text=True).strip(),
                  'retention': campaign,
                  'retention_acceptance': 'measured' if campaign else 'pending three daily cycles',
                  'limitations': 'Allocated bytes, warm caches, 128-byte fixture files. Synthetic 12-blob flat-tree parentless versions workload; not the full before/after tree builder. Projection is gross pre-GC growth; not a retention policy approval.'}
        if campaign:
            result.update(projected_14_day_bytes=campaign['projected_14_day_bytes'],
                          growth_budget_passed=campaign['growth_budget_passed'])
        (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
        return 0 if (campaign or result)['growth_budget_passed'] else 3
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
    parser.add_argument('--daily-cycles', action='store_true',
                        help='also measure three daily eight-hour retention cycles (at least 56 hours)')
    args = parser.parse_args()
    raise SystemExit(measure(args.repo, args.output, args.jj, args.daily_cycles))
