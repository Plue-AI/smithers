import importlib.util
from pathlib import Path
import unittest
import tempfile
import os
import subprocess
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("credential-soak-capture.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def complete_records():
    records = ["begin:1:20001", "version:claude:1:2:3", "version:codex:2:3:4", "version:gh:2:81:0"]
    for iteration in range(145):
        for index, tool in enumerate(("claude", "codex", "gh")):
            records.append(f"call:{tool}:{1 + iteration * 600 + index}:0:0")
    return records + ["end:86403:0"]


class Sequence(unittest.TestCase):
    def validate(self, records):
        sequence = capture.CallSequence(20001)
        for record in records:
            sequence.accept(record)
        return sequence.finish(), sequence.failure

    def test_all_three_tools_at_every_endpoint_are_required(self):
        records = complete_records()
        self.assertEqual(self.validate(records), (True, None))
        for index in [4, 220, len(records) - 2]:
            with self.subTest(missing_call=index):
                self.assertFalse(self.validate(records[:index] + records[index + 1:])[0])

    def test_sparse_and_empty_capture_refuse(self):
        for records in [[], ["end:86403:0"], ["begin:1:20001", "version:gh:2:81:0", "end:86403:0"]]:
            with self.subTest(records=records):
                self.assertFalse(self.validate(records)[0])

    def test_identity_versions_order_and_duration_refuse(self):
        replacements = {
            0: ["begin:1:20002"],
            1: ["version:gh:2:81:0"],
            4: ["call:codex:1:0:0", "call:claude:62:0:0", "call:claude:0:0:0", "call:claude:1:1:0", "call:claude:1:0:1"],
            5: ["call:codex:0:0:0", "call:codex:182:0:0"],
            -1: ["end:86400:0", "end:86402:0", "end:86403:1"],
        }
        # A full 24-hour span still refuses an end before the last gh call.
        for index, cases in replacements.items():
            for replacement in cases:
                with self.subTest(index=index, replacement=replacement):
                    records = complete_records()
                    records[index] = replacement
                    self.assertFalse(self.validate(records)[0])

    def test_missing_duplicate_and_trailing_records_refuse(self):
        records = complete_records()
        for invalid in [records[1:], records[:-1], records[:1] + records,
                        records[:2] + records[1:], records + [records[-1]],
                        records + ["call:claude:87001:0:0"], records[:4] + records[5:]]:
            with self.subTest(length=len(invalid)):
                self.assertFalse(self.validate(invalid)[0])

    def test_failure_cannot_be_cleared_by_later_success(self):
        records = complete_records()
        records.insert(100, "refused:19203:4")
        self.assertEqual(self.validate(records), (False, "guest_refused"))

    def test_bounded_sequential_tool_delays_are_accepted(self):
        records = complete_records()
        records[4:7] = ["call:claude:61:0:0", "call:codex:181:0:0", "call:gh:301:0:0"]
        self.assertEqual(self.validate(records), (True, None))

class Redaction(unittest.TestCase):
    def test_only_fixed_reports_survive_terminal_boundary(self):
        for data in ["call:claude:1:0:0", "call:codex:2:124:1", "version:gh:2:81:0", "begin:3:20001", "end:86403:0", "refused:4:2"]:
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
                result = capture.capture("smithers-mvp-canary/2026-10-05", "machine-a", 20001, evidence)
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
        result, contents = self.run_terminal(complete_records())
        self.assertEqual(result, 0)
        self.assertIn("end:86403:0", contents)
        self.assertIn('"observed_calls": 435', contents)
        self.assertIn('"capture_complete": true', contents)

    def test_sparse_zero_exit_terminal_is_not_a_complete_capture(self):
        result, contents = self.run_terminal(["begin:1:20001", "version:gh:2:81:0", "end:86401:0"])
        self.assertEqual(result, 1)
        self.assertIn('"capture_complete": false', contents)

    def test_missing_middle_call_is_preserved_as_capture_failure(self):
        records = complete_records()
        del records[220]
        result, contents = self.run_terminal(records)
        self.assertEqual(result, 1)
        self.assertIn('"observed_calls": 434', contents)
        self.assertIn('"capture_failure": "call_order"', contents)

    def test_failed_terminal_preserves_transport_status(self):
        self.assertEqual(self.run_terminal(["end:86401:0"], 7)[0], 7)

class GuestAdmission(unittest.TestCase):
    def invoke(self, uid, expected=20001, credentials=None):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            root = Path(directory)
            for name, text in {"id": f"#!/bin/sh\nprintf '%s\\n' {uid}\n", "date": "#!/bin/sh\nprintf '1\\n'\n"}.items():
                path = root / name
                path.write_text(text)
                path.chmod(0o700)
            env = {"PATH": str(root), "expected_uid": str(expected), "nonce": "test"}
            env.update(credentials or {})
            return subprocess.run(["/bin/bash", str(Path(__file__).with_name("credential-soak-guest.sh"))],
                                  env=env, text=True, capture_output=True, timeout=5)

    def test_root_and_agent_uids_refuse_before_tools(self):
        for uid in [0, 19999]:
            result = self.invoke(uid, uid)
            self.assertEqual(result.returncode, 78)
            self.assertIn("refused:1:1", result.stdout)

    def test_wrong_person_refuses_before_tools(self):
        self.assertEqual(self.invoke(20002).returncode, 78)

    def test_environment_keys_cannot_substitute_for_independent_logins(self):
        for name in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]:
            result = self.invoke(20001, credentials={name: "secret-fixture"})
            self.assertEqual(result.returncode, 78)
            self.assertIn("refused:1:5", result.stdout)
            self.assertNotIn("secret-fixture", result.stdout + result.stderr)

    def test_missing_guest_timeout_refuses(self):
        result = self.invoke(20001)
        self.assertEqual(result.returncode, 69)
        self.assertIn("refused:1:2", result.stdout)

if __name__ == "__main__":
    unittest.main()
