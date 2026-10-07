#!/usr/bin/env python3
"""Fixed privileged probe. Install only from reviewed main; accepts no inputs.

No repository paths, environment, subprocess executable or caller argv are read.
The disposable child is forked from this image-shipped interpreter.
"""
import json
import os
from pathlib import Path
import signal
import sys
import time

ROOT = Path('/sys/fs/cgroup')
GROUP = ROOT / 'smithers-col11-probe'


def wait_event(group, key, value):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        events = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())
        if events.get(key) == value:
            return True
        time.sleep(0.01)
    return False


def probe():
    if os.geteuid() != 0 or sys.platform != 'linux' or len(sys.argv) != 1:
        raise ValueError('fixed Linux root probe takes no arguments')
    if not (ROOT / 'cgroup.controllers').is_file():
        raise ValueError('cgroup v2 required')
    # Exclusive creation refuses stale or caller-prepared probe groups.
    GROUP.mkdir()
    child = None
    result = {}
    try:
        child = os.fork()
        if child == 0:
            # Child cannot touch root files or repository bytes.
            os.setgroups([])
            os.setgid(19999)
            os.setuid(19999)
            while True:
                signal.pause()
        (GROUP / 'cgroup.procs').write_text(str(child))
        (GROUP / 'cgroup.freeze').write_text('1')
        result['cgroup.freeze'] = {'yes': wait_event(GROUP, 'frozen', '1')}
        (GROUP / 'cgroup.freeze').write_text('0')
        if not wait_event(GROUP, 'frozen', '0'):
            raise ValueError('probe did not thaw')
        (GROUP / 'cgroup.kill').write_text('1')
        result['cgroup.kill'] = {'yes': wait_event(GROUP, 'populated', '0')}
        return {'uid': 0, 'probes': result}
    finally:
        if child is not None:
            # Only this helper's disposable child is signalled or reaped.
            (GROUP / 'cgroup.freeze').write_text('0')
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        GROUP.rmdir()


if __name__ == '__main__':
    print(json.dumps(probe(), sort_keys=True))
