"""Fail-closed C-SPK-02 verdict over retained real-VM observations."""
import json
import math
import sys


def evaluate(result):
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
    return {'passed': passed and any(v['passed'] for v in verdicts.values()), 'layouts': verdicts}


if __name__ == '__main__':
    try:
        verdict = evaluate(json.loads(open(sys.argv[1]).read()))
        print(json.dumps(verdict, allow_nan=False))
        sys.exit(0 if verdict['passed'] else 1)
    except (KeyError, TypeError, ValueError, IndexError, OSError) as error:
        print(json.dumps({'passed': False, 'error': str(error)}))
        sys.exit(1)
