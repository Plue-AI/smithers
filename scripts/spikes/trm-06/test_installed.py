"""Unprivileged executable refusals; not accepted real-VM boundary evidence."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class InstalledRefusal(unittest.TestCase):
    def test_installer_and_loader_refuse_checkout_before_external_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            sentinel = base / "outside"
            sentinel.write_bytes(b"outside-fixture\0")
            before = (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode)
            for name in ["supervisor", "python3", "msb"]:
                file = base / name
                file.write_text(f"#!/bin/sh\nprintf canary >> '{sentinel}'\n")
                file.chmod(0o755)
            for script in ["install.py", "launcher.py", "validation.py"]:
                modes = [""] if script != "validation.py" else ["", "boot-symlink", "boot-writable", "supervisor-replaced"]
                for mode in modes:
                    with self.subTest(script=script, mode=mode):
                        result = subprocess.run([sys.executable, "-I", "-S", str(ROOT / script), mode],
                                                input=b'{"supervisor":"branch","boot":{"uid":0}}',
                                                cwd=base, env={"PATH": str(base), "HOME": str(base)},
                                                capture_output=True, timeout=2)
                        self.assertEqual(result.returncode, 78)
                        self.assertEqual(result.stdout, b"")
                        self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)



if __name__ == "__main__":
    if os.geteuid() == 0:
        raise SystemExit("run refusal controls unprivileged")
    unittest.main()
