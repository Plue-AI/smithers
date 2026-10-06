import importlib.util
from pathlib import Path
import unittest
import tempfile
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("credential-soak-capture.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

class Redaction(unittest.TestCase):
    def test_only_fixed_reports_survive_terminal_boundary(self):
        for data in ["call:claude:1:0:0", "call:codex:2:124:1", "version:gh:2:81:0", "begin:3:1001", "end:86403:0", "refused:4:2"]:
            self.assertEqual(capture.redacted_line("SOAK:nonce:" + data + "\r\n", "nonce"), data)

    def test_credentials_prompts_echo_and_escape_sequences_are_discarded(self):
        for line in ["token=secret", "SOAK:other:call:gh:1:0:0", "SOAK:nonce:call:gh:1:0:0 secret", "SOAK:nonce:version:gh:secret", "printf 'SOAK:nonce:call:gh:1:0:0'", "\x1b[1mSOAK:nonce:call:gh:1:0:0", "SOAK:nonce:call:gh:1:0:2"]:
            self.assertIsNone(capture.redacted_line(line, "nonce"))

class CaptureBoundary(unittest.TestCase):
    # A terminal-process double verifies the recorder, never C-REL-05.
    def run_terminal(self, records, status=0):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            root = Path(directory)
            executable = root / "smthrs"
            executable.write_text("#!/usr/bin/env python3\n" +
                "import sys\n" +
                "assert sys.argv[1:] == ['workspace', 'shell', 'machine-a', '--repo', 'smithers-mvp-canary/2026-10-05', '--cols', '1000']\n" +
                "nonce = None\n" +
                "for line in sys.stdin:\n" +
                " if line.startswith('nonce='): nonce = line.strip().split('=', 1)[1]\n" +
                " if line.strip() == 'SMITHERS_SOAK_GUEST': break\n" +
                "print('token=secret-output-that-must-not-survive')\n" +
                f"for record in {records!r}: print('SOAK:' + nonce + ':' + record)\n" +
                f"sys.exit({status})\n")
            executable.chmod(0o700)
            evidence = root / "evidence"
            evidence.mkdir()
            with patch.dict(os.environ, {"PATH": str(root) + os.pathsep + os.environ["PATH"]}):
                result = capture.capture("smithers-mvp-canary/2026-10-05", "machine-a", 1001, evidence)
            contents = "".join(file.read_text() for file in evidence.iterdir())
            self.assertNotIn("secret-output", contents)
            self.assertIn('"qualification": "not evaluated"', contents)
            return result, contents

    def test_transport_completion_without_guest_end_refuses(self):
        self.assertEqual(self.run_terminal([])[0], 78)

    def test_guest_refusal_and_login_prompt_cannot_be_capture_success(self):
        for records in [["refused:1:2"], ["call:claude:1:0:1", "end:86401:0"], ["call:gh:1:1:0", "end:86401:0"]]:
            self.assertEqual(self.run_terminal(records)[0], 1)

    def test_completed_capture_is_still_not_qualification(self):
        result, contents = self.run_terminal(["begin:1:1001", "version:gh:2:81:0", "end:86401:0"])
        self.assertEqual(result, 0)
        self.assertIn("end:86401:0", contents)

    def test_failed_terminal_preserves_transport_status(self):
        self.assertEqual(self.run_terminal(["end:86401:0"], 7)[0], 7)

if __name__ == "__main__":
    unittest.main()
