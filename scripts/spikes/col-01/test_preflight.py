"""Launch-boundary checks: a refusal precedes any build or VM command."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class PreflightTests(unittest.TestCase):
    def test_launch_refuses_unapproved_inputs_before_toolchain(self):
        for mutation in ['changed', 'extra', 'missing', 'symlink', 'missing-main', 'host-code', 'image', 'toolchain', 'plist', 'root-helper', 'no-isolation']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                spike = root / 'scripts/spikes/col-01'
                spike.mkdir(parents=True)
                for name in ['run.sh', 'preflight.py']:
                    shutil.copyfile(Path(__file__).with_name(name), spike / name)
                helper = root / 'packages/backend/microsandbox/guest/helper.py'
                helper.parent.mkdir(parents=True)
                helper.write_text('reviewed helper\n')
                def git(*args):
                    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)
                git('init', '-q')
                git('add', '.')
                git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid',
                    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
                git('update-ref', 'refs/remotes/origin/main', 'HEAD')
                if mutation == 'changed':
                    helper.write_text('branch helper\n')
                elif mutation == 'extra':
                    helper.with_name('extra.py').write_text('branch helper\n')
                elif mutation == 'missing':
                    helper.unlink()
                elif mutation == 'symlink':
                    helper.rename(helper.with_name('target'))
                    helper.symlink_to('target')
                elif mutation == 'host-code':
                    (spike / 'run.sh').write_text((spike / 'run.sh').read_text() + '\n# branch build\n')
                elif mutation == 'missing-main':
                    git('update-ref', '-d', 'refs/remotes/origin/main')
                import os
                env = {k: v for k, v in os.environ.items() if k not in [
                    "GOFLAGS", "GOENV", "PYTHONPATH", "PYTHONHOME", "RUSTC_WRAPPER", "RUSTUP_TOOLCHAIN"]}
                key = {'image': 'SPIKE_IMAGE', 'toolchain': 'SPIKE_TOOLCHAIN',
                       'plist': 'SPIKE_PLIST', 'root-helper': 'SPIKE_ROOT_HELPER'}.get(mutation)
                if key:
                    env[key] = str(helper)
                result = subprocess.run(['bash', str(spike / 'run.sh'), 'rtt'],
                                        capture_output=True, text=True, env=env)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('SPIKE SECURITY BLOCKED:', result.stderr)
                self.assertFalse((root / '.artifacts').exists())
                if mutation == 'no-isolation':
                    self.assertIn('no host fallback', result.stderr)

    def test_store_refuses_before_provisioning_or_output_creation(self):
        import os
        import sys
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            spike = root / 'scripts/spikes/col-01'
            spike.mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name('store.sh'), spike / 'store.sh')
            # Isolate the store entry point after a successful host preflight.
            # This does not qualify the host or guest for real measurement.
            (spike / 'preflight.py').write_text('raise SystemExit(0)\n')
            tools = root / 'tools'
            tools.mkdir()
            (tools / 'python3').symlink_to(sys.executable)
            for name in ['node', 'msb', 'mkdir', 'git']:
                tool = tools / name
                tool.write_text('#!/bin/sh\nprintf invoked > "' + str(root / 'invoked') + '"\nexit 99\n')
                tool.chmod(0o755)
            output = root / 'store-output'
            result = subprocess.run(['/bin/bash', str(spike / 'store.sh'),
                                     'a' * 40, str(output)], capture_output=True,
                                    text=True, env={**os.environ, 'PATH': str(tools) + ':/usr/bin:/bin'})
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('qualified non-root guest provisioning', result.stderr)
            self.assertFalse(output.exists())
            self.assertFalse((root / 'invoked').exists())

    def test_approved_inventory_is_bound_to_main(self):
        import preflight
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            helper = root / 'packages/backend/microsandbox/guest/helper.py'
            helper.parent.mkdir(parents=True)
            helper.write_text('reviewed helper\n')
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)
            git('init', '-q')
            git('add', '.')
            git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid',
                '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
            git('update-ref', 'refs/remotes/origin/main', 'HEAD')
            with patch.dict("os.environ", {}, clear=True):
                result = preflight.verify(root)
            self.assertEqual(result['main_pinned_runtime_commit'], git('rev-parse', 'HEAD').decode().strip())
            self.assertEqual(len(result['runtime_inputs']), 1)
