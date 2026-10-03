"""Fail-closed C-SPK-02 verdict over retained real-VM observations."""
import json
import math
import sys
from concurrent import extension_pass


def evaluate_matrix(result):
    verdicts = {}
    for layout in ('A', 'B'):
        data = result.get('layouts', {}).get(layout, {})
        reasons = []
        steps = data.get('steps', [])

        def require(condition, message):
            if not condition:
                reasons.append(message)

        def step(phase, kind, member, actor=None):
            matches = [s for s in steps if s.get('phase') == phase and s.get('kind') == kind
                       and s.get('member') == member and (actor is None or s.get('actor_uid') == actor)]
            return matches[0] if len(matches) == 1 else {}

        def ok(record):
            return type(record.get('exit_code')) is int and record['exit_code'] == 0

        for member, uid, other in [('ben', 20001, 20002), ('alice', 20002, 20001)]:
            if layout == 'A':
                require(ok(step('initial', 'chown', member)), f'{member}: chown failed/missing')
            require(ok(step('initial', 'chmod', member)), f'{member}: chmod failed/missing')
            write = step('initial', 'write', member, uid)
            wd = write.get('data') or {}
            require(ok(write) and wd.get('uid') == uid and wd.get('gid') == uid
                    and wd.get('errno') is None, f'{member}: owner write failed')
            for phase in ('initial', 'reboot', 'second_vm'):
                stat = step(phase, 'stat', member)
                st = stat.get('data') or {}
                require(ok(stat) and st.get('uid') == uid and st.get('gid') == uid
                        and st.get('mode') == '700', f'{phase}/{member}: expected {uid}:{uid} 0700')
                for actor in (uid, other, 19999):
                    read = step(phase, 'read', member, actor)
                    rd = read.get('data') or {}
                    identity = rd.get('uid') == actor and rd.get('gid') == actor
                    if actor == uid:
                        valid = ok(read) and rd.get('errno') is None and rd.get('value') == f'login-{member}'
                    else:
                        valid = type(read.get('exit_code')) is int and read['exit_code'] != 0 and rd.get('errno') == 'EACCES'
                    require(identity and valid, f'{phase}/{member}: read as {actor} failed expectation')
        host = {h.get('path'): h for h in data.get('host', [])}
        for path in ('.', 'ben', 'alice'):
            h = host.get(path, {})
            require(type(result.get('host_uid')) is int and type(h.get('uid')) is int
                    and h.get('uid') == result['host_uid'] and h.get('mode') == '700',
                    f'host/{path}: expected host-owned 0700 ancestor')
        samples = data.get('samples', [])
        delays = [s.get('delay_ms') for s in samples]
        finite = all(type(d) in (int, float) and math.isfinite(d) and d >= 0 for d in delays)
        p95 = sorted(delays)[94] if len(samples) == 100 and finite else None
        fresh = len(samples) == 100 and [s.get('seq') for s in samples] == list(range(1, 101))
        for s in samples:
            fresh = fresh and s.get('expected') == f'mch02-{s.get("seq")}' and s.get('observed') == s.get('expected')
            fresh = fresh and type(s.get('write_exit_code')) is int and s['write_exit_code'] == 0
            fresh = fresh and type(s.get('read_exit_code')) is int and s['read_exit_code'] == 0
        require(fresh, 'requires 100/100 successful fresh cross-VM samples')
        require(p95 is not None and p95 <= 1000, 'cross-VM visibility p95 must be <=1000 ms')
        if layout == 'B':
            require(data.get('boot_mounts_required') is True and
                    data.get('boot_mount_note') == 'Every member needs a mount at VM boot.',
                    'B requires a mount for every member at VM boot')
        verdicts[layout] = {'passed': not reasons, 'reasons': reasons, 'p95_ms': p95}
    passed = result.get('completed') is True and not result.get('errors') and not result.get('unremoved_vms')
    return {'passed': passed and verdicts['B']['passed'], 'layouts': verdicts}


def evaluate(result):
    matrix = evaluate_matrix(result)
    concurrent = result.get('concurrent', {})
    reasons = []
    if not matrix['passed']:
        reasons.append('Layout B ownership/visibility matrix failed or incomplete.')
    hot_add = result.get('layouts', {}).get('B', {}).get('hot_add', {})
    if not all(isinstance(hot_add.get(key), dict) and
               type(hot_add[key].get('exit_code')) is int and hot_add[key].get('command')
               for key in ('attempt', 'guest_after')):
        reasons.append('Layout B hot-add probe and guest observation must be recorded.')
    partial = not isinstance(concurrent, dict) or 'atomic' not in concurrent
    atomic_passed = extension_pass(concurrent)
    if not atomic_passed:
        reasons.append('Concurrent atomic-write step 6 failed or incomplete.')
    return dict(passed=not reasons, partial=partial, matrix_passed=matrix['passed'],
                atomic_passed=atomic_passed, layouts=matrix['layouts'], reasons=reasons)

def decision_evidence(directory):
    """Validate retained data only; never invoke a lifecycle or evidence command.

    Adds decision completion beside the existing hypothesis evaluator, rather
    than replacing its NO with a successful shared-home benchmark.
    """
    import csv
    import io
    import re
    import shlex
    from pathlib import Path
    from concurrent import lock_result, valid

    root = Path(directory)
    if root.is_symlink():
        raise ValueError('symlink evidence directory')
    root = root.resolve()
    def require(ok, reason):
        if not ok:
            raise ValueError(reason)

    def text(name):
        path = root / name
        require(not root.is_symlink() and not any(p.is_symlink() for p in [path, *path.parents]),
                f'symlink evidence: {name}')
        value = path.read_text()
        require(bool(value.strip()) and value.endswith('\n'), f'empty/truncated evidence: {name}')
        return value

    def decode(value):
        def pairs(rows):
            result = {}
            for key, value in rows:
                require(key not in result, f'duplicate JSON key: {key}')
                result[key] = value
            return result
        return json.loads(value, object_pairs_hook=pairs,
                          parse_constant=lambda v: (_ for _ in ()).throw(ValueError(v)))

    def read(name):
        return decode(text(name))

    def commands(name):
        rows = [decode(line) for line in text(name).splitlines()]
        require(all(isinstance(r, dict) and type(r.get('exit_code')) is int and
                    isinstance(r.get('command'), str) and r['command'] and
                    isinstance(r.get('stdout'), str) and isinstance(r.get('stderr'), str)
                    for r in rows), f'malformed command evidence: {name}')
        return rows

    result = read('results.json')
    require(isinstance(result, dict), 'results must be an object')
    require(result.get('completed') is True and result.get('errors') == [] and
            result.get('unremoved_vms') == [], 'matrix execution incomplete')
    require(type(result.get('host_uid')) is int and result['host_uid'] > 0,
            'host must be non-root')
    require(result.get('msb_version') == 'msb 0.6.16' and
            result.get('image') == 'node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b' and
            re.fullmatch('[0-9a-f]{40}', result.get('revision', '')),
            'missing pinned runtime/revision identity')
    matrix = read('matrix-results.json')
    require(all(matrix.get(k) == v for k, v in result.items()
                if k not in ('concurrent', 'concurrent_exit_code', 'verdict')),
            'matrix raw/result mismatch')
    logs = commands('commands.jsonl')
    creates = {}
    layout_mounts = {}
    for row in logs:
        argv = shlex.split(row['command'])
        if len(argv) < 2 or argv[1] != 'create':
            continue
        require(row['exit_code'] == 0 and argv[2] == result['image'] and
                argv.count('-n') == 1, 'invalid pinned create')
        name = argv[argv.index('-n') + 1]
        require(name not in creates, 'duplicate VM identity')
        mounts = [argv[i + 1] for i, arg in enumerate(argv) if arg == '--mount-dir']
        layout = 'A' if len(mounts) == 1 else 'B'
        if layout == 'A':
            require(mounts[0].endswith('/A/homes:/home'), 'invalid A mount')
        else:
            require(len(mounts) == 2 and all(any(m.endswith(
                f'/B/homes/{member}:/home/{member}:uid={uid},gid={uid}') for m in mounts)
                for member, uid in [('ben', 20001), ('alice', 20002)]), 'invalid B ownership mounts')
        require(all(m.startswith('/') for m in mounts), 'mount sources must be absolute')
        require(layout not in layout_mounts or layout_mounts[layout] == mounts,
                'VMs must share the same layout mounts')
        layout_mounts[layout] = mounts
        creates[name] = layout
    require(len(creates) == 4 and list(creates.values()).count('A') == 2 and
            list(creates.values()).count('B') == 2, 'requires two VMs per layout')
    require(set(result.get('layouts', {})) == {'A', 'B'}, 'requires both layouts')
    for layout in ('A', 'B'):
        data = result['layouts'][layout]
        steps = data['steps']
        expected = set()
        # C-SPK-02 steps 2-5,9: fixed actors, phases and 0700 oracle.
        for phase in ('initial', 'reboot', 'second_vm'):
            expected.add((phase, 'mount_root', '.', None))
            for member, uid, other in (('ben', 20001, 20002), ('alice', 20002, 20001)):
                expected.add((phase, 'stat', member, None))
                for actor in (uid, other, 19999):
                    expected.add((phase, 'read', member, actor))
                if phase == 'initial':
                    expected.update((phase, k, member, None) for k in
                                    (('mkdir', 'chown', 'chmod') if layout == 'A' else ('chmod',)))
                    expected.add((phase, 'write', member, uid))
        keys = [(s['phase'], s['kind'], s['member'], s.get('actor_uid')) for s in steps]
        require(len(keys) == len(expected) and set(keys) == expected, f'{layout}: truncated/duplicate matrix')
        raw = []
        phase_vms = {}
        for row in logs:
            try:
                value = decode(row['stdout'])
            except ValueError:
                continue
            if isinstance(value, list) and value and isinstance(value[0], dict) and 'phase' in value[0]:
                # VM is added by the historical coordinator after recording stdout.
                phase = value[0]['phase']
                normalized = [dict(s, vm=2 if phase == 'second_vm' else 1) for s in value]
                if all(s in steps for s in normalized):
                    argv = shlex.split(row['command'])
                    require('--' in argv, 'missing matrix exec arguments')
                    name = argv[argv.index('--') - 1]
                    require(argv[-2:] == [layout, phase] and creates.get(name) == layout and phase not in phase_vms,
                            'matrix VM/layout identity mismatch')
                    phase_vms[phase] = name
                    raw.extend(normalized)
        require(raw == steps, f'{layout}: raw matrix log mismatch')
        require(phase_vms['initial'] == phase_vms['reboot'] and
                phase_vms['initial'] != phase_vms['second_vm'], 'invalid restart/second VM')
        initial = phase_vms['initial']
        for action in ('stop', 'start'):
            require(any(r['exit_code'] == 0 and shlex.split(r['command'])[1] == action and
                        shlex.split(r['command'])[-1] == initial for r in logs), 'restart receipt missing')
        for s in steps:
            require(type(s.get('exit_code')) is int and isinstance(s.get('command'), list) and
                    isinstance(s.get('stdout'), str) and isinstance(s.get('stderr'), str), 'missing matrix command')
            kind, actor = s['kind'], s.get('actor_uid')
            if kind in ('stat', 'read', 'write'):
                require(decode(s['stdout']) == s.get('data'), 'raw probe stdout/data mismatch')
            if kind == 'stat':
                uid = 20001 if s['member'] == 'ben' else 20002
                require(s['exit_code'] == 0 and s['data'] == dict(uid=uid, gid=uid, mode='700'),
                        'ownership evidence disagrees with accepted NO')
            elif actor is not None:
                d = s['data']
                require(all(k in d for k in ('uid', 'gid', 'groups', 'errno')),
                        'incomplete probe observation')
                require(d.get('uid') == actor and d.get('gid') == actor and d.get('groups') in ([], [actor]),
                        'uncleared/incorrect guest identity')
                denied = layout == 'A' or actor != (20001 if s['member'] == 'ben' else 20002)
                require((s['exit_code'] != 0 and d.get('errno') == 'EACCES') if denied else
                        (s['exit_code'] == 0 and d.get('errno') is None), 'unexpected traversal/read evidence')
            elif kind == 'mount_root' and layout == 'A':
                require(s['exit_code'] == 0 and s['stdout'].strip() == '0:0 700 /home', 'A traversal root missing')
            else:
                require(s['exit_code'] == 0, 'matrix metadata/setup failed')
        samples = data['samples']
        require(len(samples) == 100 and [s['seq'] for s in samples] == list(range(1, 101)),
                'requires 100 ordered samples')
        csv_rows = list(csv.DictReader(io.StringIO(text(f'{layout}-delays.csv'))))
        require(len(csv_rows) == 100, 'truncated delay CSV')
        for row, sample in zip(csv_rows, samples):
            require(all(row.get(k) == ('' if v is None else str(v)) for k, v in sample.items()),
                    'delay CSV/result mismatch')
            require(sample['expected'] == f"mch02-{sample['seq']}" and
                    type(sample['delay_ms']) in (int, float) and math.isfinite(sample['delay_ms']) and
                    sample['delay_ms'] >= 0, 'invalid delay sample')
        listing = text(f'{layout}-host-ls-ln.txt')
        for member in ('ben', 'alice'):
            require(re.search(r'^drwx------[+@]?\s+\d+\s+' + str(result['host_uid']) +
                              r'\s+\d+\s+.*\s' + member + r'$', listing, re.MULTILINE),
                    'malformed host ownership listing')
        host = {h['path']: h for h in data['host']}
        require(all(host.get(p, {}).get('uid') == result['host_uid'] and
                    host.get(p, {}).get('mode') == '700' for p in ('.', 'ben', 'alice')),
                'host ownership/mode missing')
    require(evaluate_matrix(result)['layouts']['B']['passed'], 'B ownership/visibility incomplete')
    hot = result['layouts']['B']['hot_add']
    require(all(hot[k] in logs for k in ('attempt', 'guest_after')), 'hot-add raw logs missing')
    concurrent = read('concurrent/results.json')
    require(concurrent == result.get('concurrent') and concurrent.get('completed') is True and
            concurrent.get('errors') == [] and concurrent.get('unremoved_vms') == [], 'concurrent incomplete')
    clog = commands('concurrent/commands.jsonl')
    require(concurrent.get('msb_version') == 'msb 0.6.16' and
            concurrent.get('image') == result['image'] and
            re.fullmatch('[0-9a-f]{40}', concurrent.get('revision', '')) and
            concurrent.get('host', {}).get('uid') == result['host_uid'], 'concurrent runtime missing')
    text('concurrent/create-help.txt')
    text('concurrent/host-ls-ln.txt')
    for phase, workers in [('files', concurrent['files']['workers']),
                           ('atomic', concurrent['atomic']['workers']),
                           ('sqlite-delete', concurrent['sqlite']['DELETE']['workers']),
                           ('sqlite-wal', concurrent['sqlite']['WAL']['workers'])]:
        require(sorted(w['vm'] for w in workers) == ['1', '2'], f'{phase}: missing worker')
        for w in workers:
            require(w.get('uid') == 20001 and w.get('gid') == 20001 and
                    w.get('completed') is True and w.get('iterations') == 1000, 'worker identity/completion missing')
            stdout = text(f"concurrent/{phase}-vm{w['vm']}.stdout")
            rows = [decode(line[7:]) for line in stdout.splitlines() if line.startswith('RESULT ')]
            require(rows == [w] and any(r['stdout'] == stdout and r['exit_code'] == 0 for r in clog),
                    'truncated/mismatched concurrent worker log')
    atomic = concurrent['atomic']
    require(all(len(w['shared_reads']) == 1000 for w in atomic['workers']), 'truncated shared read log')
    require(all(w.get('errors') == [] for w in atomic['workers']), 'atomic worker errors missing')
    manifest = read('concurrent/atomic-manifest.json')
    expected_paths = {f'vm{vm}-{seq}' for vm in ('1', '2') for seq in range(1, 1001)}
    require(len(manifest) == 2000 and {m['path'] for m in manifest} == expected_paths and
            all(type(m.get('exists')) is bool and type(m.get('correct')) is bool and
                (re.fullmatch('[0-9a-f]{64}', m.get('sha256') or '') if m['exists'] else m.get('sha256') is None)
                for m in manifest), 'truncated/malformed atomic manifest')
    def read_observation(row):
        return (isinstance(row, dict) and 'error' in row and 'observed' in row and
                ((row['error'] is None and valid(row['observed'])) or
                 (isinstance(row['error'], str) and bool(row['error']) and row['observed'] is None)))

    require(all(read_observation(r) for w in atomic['workers'] for r in w['shared_reads']),
            'malformed shared reads')
    host = atomic['host']
    require(all(type(host.get(k)) is int and host[k] >= 0 for k in ('present', 'missing', 'corrupted'))
            and valid(host.get('final')), 'atomic host observation missing')
    require(host['missing'] == sum(not m['exists'] for m in manifest) and
            host['corrupted'] == sum(m['exists'] and not m['correct'] for m in manifest) and
            host['present'] == sum(m['exists'] and m['correct'] for m in manifest), 'host manifest/count mismatch')
    require(sorted(g['vm'] for g in atomic['guests']) == ['1', '2'], 'missing atomic guest')
    for guest in atomic['guests']:
        entries = guest['manifest']
        require(len(entries) == 2000 and {m['path'] for m in entries} == expected_paths and
                all((type(m.get('correct')) is bool and
                     re.fullmatch('[0-9a-f]{64}', m.get('sha256', ''))) or
                    (isinstance(m.get('error'), str) and bool(m['error'])) for m in entries),
                'malformed guest manifest')
        require(all(type(guest.get(k)) is int and guest[k] >= 0 for k in ('present', 'missing', 'corrupted'))
                and guest['present'] == sum(m.get('correct') is True for m in entries) and
                guest['missing'] == sum(m.get('error') == 'ENOENT' for m in entries) and
                guest['corrupted'] == sum(m.get('correct') is False or
                    ('error' in m and m['error'] != 'ENOENT') for m in entries) and
                valid(guest.get('final')) and isinstance(guest.get('final_reads'), list) and
                guest['final_reads'] and all(read_observation(r) for r in guest['final_reads']),
                'guest observation/count missing')
        raw_guest = {k: v for k, v in guest.items() if k != 'sha_mismatches'}
        require(any(r['exit_code'] == 0 and r['stdout'].lstrip().startswith('{') and decode(r['stdout']) == raw_guest
                    for r in clog), 'guest raw receipt missing')
    # C-SPK-02 accepted NO: actual ENOENT in interleaved atomic reads, not
    # an absent log, cached verdict, or an uncontrolled flock result.
    require(any(r.get('error') == 'ENOENT' for w in atomic['workers'] for r in w['shared_reads']),
            'accepted concurrent data loss missing')
    locks = concurrent['locks']
    require(len(locks) == 6 and len({(r['path'], r['holder'], r['contender']) for r in locks}) == 6
            and all(r['path'] in ('.claude', '.config/gh', '.npm/_cacache') and
                    r['holder'] != r['contender'] for r in locks), 'lock probes incomplete')
    pairs = {(r['holder'], r['contender']) for r in locks}
    require(len(pairs) == 2 and all((b, a) in pairs and a != b for a, b in pairs),
            'lock directions incomplete')
    classifications = []
    for row in locks:
        for key in ('holder_receipt', 'contender_receipt'):
            require(isinstance(row.get(key), dict) and row[key] in clog, 'lock probe receipt missing')
        require(type(row.get('held_during_attempt')) is bool and
                'LOCK_HELD' in row['holder_receipt']['stdout'] and
                all(isinstance(row[k], str) and row[k] in row[receipt]['command'] and
                    row['path'] in row[receipt]['command'] for k, receipt in
                    [('holder', 'holder_receipt'), ('contender', 'contender_receipt')]),
                'lock holder/direction observation missing')
        if 'same_vm_receipt' not in row:
            classifications.append('uncontrolled')
        else:
            require(row['same_vm_receipt'] in clog, 'lock control raw receipt missing')
            fresh = lock_result(row['path'], row['holder'], row['contender'], row['holder_receipt'],
                                row['contender_receipt'], row['same_vm_receipt'], row['held_during_attempt'])
            require(fresh == row, 'forged lock classification')
            classifications.append('controlled' if fresh['controlled'] else 'uncontrolled')
    verdict = evaluate(result)
    require(verdict['passed'] is False and result.get('verdict') == verdict and
            read('check-summary.json') == verdict, 'forged cached hypothesis verdict')
    return dict(check='C-SPK-02', decision_completed=True, hypothesis='NO',
                accepted_by='smithers-8a', homes='per-machine', shared_homes_enabled=False,
                hypothesis_verdict=verdict, lock_classifications=classifications)


def decision_main(directory):
    import os
    try:
        if os.getuid() == 0:
            raise ValueError('decision evidence validation requires non-root')
        receipt = decision_evidence(directory)
        print(json.dumps(receipt, allow_nan=False))
        return 0
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
        print(f'C-SPK-02 evidence refused: {error}', file=sys.stderr)
        return 2



if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--decision-evidence':
        sys.exit(decision_main(sys.argv[2]))
    try:
        verdict = evaluate(json.loads(open(sys.argv[1]).read()))
        print(json.dumps(verdict, allow_nan=False))
        sys.exit(0 if verdict['passed'] else 1)
    except (KeyError, TypeError, ValueError, IndexError, OSError) as error:
        print(json.dumps({'passed': False, 'error': str(error)}))
        sys.exit(1)
