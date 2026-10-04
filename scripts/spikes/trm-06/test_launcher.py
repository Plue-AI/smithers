"""Refusal-only regression tests, not C-SPK-08 root-validation receipts.

The real installed positive control and init/SSH boundaries are unavailable.
These tests execute shell preflight unprivileged, never prototype host/root code.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class LauncherRefusal(unittest.TestCase):
    def test_all_entry_points_refuse_before_external_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            sentinel = base / "outside"
            sentinel.write_bytes(b"outside-fixture\x00")
            before = (sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode)
            for name in ["dirname", "pwd", "git", "msb", "python3", "go", "cargo", "sudo", "sha256sum"]:
                canary = base / name
                canary.write_text(f"#!/bin/sh\nprintf canary >> '{sentinel}'\nexit 0\n")
                canary.chmod(0o755)
            for script in ["run.sh", "revoke.sh", "flow.sh"]:
                for mode in ["", "root-prototype-install-validation", "root-session-input-validation", "--install", "--accept", "--artifact=branch"]:
                    with self.subTest(script=script, mode=mode):
                        env = {"PATH": str(base), "HOME": str(base), "PYTHONPATH": str(base),
                               "TRM06_ACCEPTED": "1", "TRM06_BUNDLE": str(base), "TRM06_RECEIPTS": str(base)}
                        result = subprocess.run(["/bin/sh", str(ROOT / script), mode], cwd=base,
                                                env=env, capture_output=True, timeout=2)
                        self.assertEqual(result.returncode, 78)
                        self.assertEqual(result.stdout, b"")
                        refusal = json.loads(result.stderr)
                        self.assertEqual(refusal["class"], "unavailable")
                        self.assertEqual(refusal["code"], "prototype_authority_unavailable")
                        self.assertEqual(refusal["check"], "C-SPK-08")
                        self.assertEqual((sentinel.read_bytes(), sentinel.stat().st_uid, sentinel.stat().st_mode), before)
            self.assertEqual(sorted(p.name for p in base.iterdir()),
                             sorted(["outside", "dirname", "pwd", "git", "msb", "python3", "go", "cargo", "sudo", "sha256sum"]))


if __name__ == "__main__":
    if os.geteuid() == 0:
        raise SystemExit("refuse: run preflight regression tests unprivileged")
    unittest.main()
