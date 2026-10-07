"""Entry-point refusal tests, not Homebrew/GUI/boot qualification evidence."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).parent


class TestHomebrewSpikeRootInputs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.script = self.root / 'scripts/spikes/homebrew-hypervisor'
        self.script.mkdir(parents=True)
        for name in ('run.sh', 'preflight.py'):
            shutil.copy2(SOURCE / name, self.script / name)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('SMITHERS_', 'MSB_', 'DYLD_', 'LD_'))}
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Input fixture')
        self.git('add', 'scripts')
        self.git('commit', '-m', 'fixture harness')
        revision = self.git('rev-parse', 'HEAD').strip()
        # Inert files: never executable, never used to claim a VM ran.
        names = ('bin/msb', 'bin/smithers-backend', 'lib/libkrunfw.5.dylib',
                 'share/microsandbox/base-image.oci.tar', 'share/microsandbox/base-image.json')
        image = 'node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b'
        entries = []
        for name in names:
            path = self.bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({'image': image}) if name.endswith('.json') else 'inert fixture')
            path.chmod(0o600)
            entries.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'mode': 0o600})
        manifest = self.bundle / 'manifest.json'
        manifest.write_text(json.dumps({'version': 1, 'platform': 'darwin-arm64', 'revision': revision, 'files': entries}))
        approval = self.root / 'distribution/homebrew-spike-approved.json'
        approval.parent.mkdir()
        approval.write_text(json.dumps({'version': 1, 'image': image, 'revision': revision,
            'acceptedBy': ['smithers-3f', 'smithers-b8'],
            'manifestSHA256': hashlib.sha256(manifest.read_bytes()).hexdigest()}))
        self.git('add', 'distribution')
        self.git('commit', '-m', 'fixture approval')

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', '-C', str(self.root), *args], stderr=subprocess.PIPE, text=True)

    def run_entry(self, *args, environment=None):
        result = subprocess.run(['/bin/bash', str(self.script / 'run.sh'), '--bundle', str(self.bundle), *args],
                                env=environment or self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        for row in rows:
            self.assertEqual(row['vm_commands'], 0)
        return rows

    def test_positive_control_verifies_inputs_but_never_claims_qualification(self):
        rows = self.run_entry()
        self.assertEqual(rows[0]['status'], 'inputs-verified')
        self.assertEqual(rows[-1]['status'], 'refused')
        self.assertIn('fresh-user', rows[-1]['reason'])

    def test_branch_artifact(self):
        (self.bundle / 'bin/msb').write_text('branch executable')
        self.assertIn('hash/mode mismatch', self.run_entry()[0]['reason'])

    def test_branch_image(self):
        (self.bundle / 'share/microsandbox/base-image.oci.tar').write_text('branch image')
        self.assertIn('hash/mode mismatch', self.run_entry()[0]['reason'])

    def test_mount_and_command_are_not_inputs(self):
        for args in (('--mount', '/repo'), ('--command', 'id'), ('--image', 'branch:latest')):
            result = subprocess.run(['/bin/bash', str(self.script / 'run.sh'), '--bundle', str(self.bundle), *args],
                                    env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('unrecognized arguments', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_inherited_guest_environment(self):
        for key in ('MSB_HOME', 'SMITHERS_MICROSANDBOX_BIN', 'MSB_COMMAND', 'LD_PRELOAD'):
            self.assertIn('inherited guest/runtime environment',
                          self.run_entry(environment={**self.env, key: '/branch'})[0]['reason'])

    def test_lane_approval_is_not_trusted(self):
        self.git('checkout', '-b', 'lane')
        self.git('rm', 'distribution/homebrew-spike-approved.json')
        self.git('commit', '-m', 'remove from lane')
        self.assertEqual(self.run_entry()[0]['status'], 'inputs-verified')
        self.git('update-ref', 'refs/heads/main', 'HEAD')
        self.assertEqual(self.run_entry()[0]['status'], 'refused')

    def test_extra_file_or_symlink(self):
        extra = self.bundle / 'bin/helper'
        extra.write_text('branch helper')
        self.assertIn('inventory mismatch', self.run_entry()[0]['reason'])
        extra.unlink()
        extra.symlink_to('/bin/sh')
        self.assertIn('symlinks', self.run_entry()[0]['reason'])

    def test_missing_bundle(self):
        shutil.rmtree(self.bundle)
        self.assertEqual(self.run_entry()[0]['status'], 'refused')


if __name__ == '__main__':
    unittest.main()
