"""Real file/lock receipt regressions; not real-VM cgroup evidence."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("trm06_validation", ROOT / "validation.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ObserverReceipt(unittest.TestCase):
    def test_reader_waits_for_complete_locked_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "observer.json"
            fixture.OBSERVER = path
            # A separate writer exposes invalid partial JSON while holding the
            # same lock the real detached observer inherits from its parent.
            writer = subprocess.Popen([sys.executable, "-I", "-S", "-c", """
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
os.write(fd, b'{"groups":')
print('ready', flush=True)
time.sleep(.1)
os.write(fd, b'["s-0000000000000001"],"zero":{},"samples":[]}')
os.fsync(fd)
os.close(fd)
""", str(path)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(writer.stdout.readline(), "ready\n")
                # Production requires a root-owned observation. This test uses
                # its actual unprivileged UID without bypassing locking or I/O.
                original = fixture.os.fstat
                def own_stat(fd):
                    info = original(fd)
                    values = list(info)
                    values[4] = 0
                    return os.stat_result(values)
                fixture.os.fstat = own_stat
                try:
                    result = fixture.observed_drain()
                finally:
                    fixture.os.fstat = original
                self.assertEqual(result, {"groups": ["s-0000000000000001"], "zero": {}, "samples": []})
                self.assertFalse(path.exists())
                self.assertEqual(writer.wait(timeout=2), 0)
            finally:
                if writer.poll() is None:
                    writer.kill()
                    writer.wait()
                writer.stdout.close()

    def test_unlocked_truncated_receipt_is_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "observer.json"
            fixture.OBSERVER = path
            path.write_bytes(b'{"groups":')
            path.chmod(0o600)
            original = fixture.os.fstat
            def own_stat(fd):
                values = list(original(fd))
                values[4] = 0
                return os.stat_result(values)
            fixture.os.fstat = own_stat
            try:
                with self.assertRaises(json.JSONDecodeError):
                    fixture.observed_drain()
            finally:
                fixture.os.fstat = original
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
