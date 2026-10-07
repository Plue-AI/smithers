"""Launch-boundary checks: a refusal precedes any build or VM command."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class PreflightTests(unittest.TestCase):
    def test_launch_refuses_unapproved_inputs_before_toolchain(self):
        for mutation in ['changed', 'extra', 'missing', 'symlink', 'missing-main', 'host-code', 'image', 'toolchain', 'plist', 'root-helper', 'backend-source', 'build-manifest']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                spike = root / 'scripts/spikes/col-01'
                spike.mkdir(parents=True)
                for name in ['run.sh', 'preflight.py']:
                    shutil.copyfile(Path(__file__).with_name(name), spike / name)
                helper = root / 'packages/backend/microsandbox/guest/helper.py'
                helper.parent.mkdir(parents=True)
                helper.write_text('reviewed helper\n')
                source = root / 'packages/backend/workspace.go'
                source.write_text('reviewed backend source\n')
                manifest = root / 'go.mod'
                manifest.write_text('reviewed build manifest\n')
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
                elif mutation == 'backend-source':
                    source.write_text('branch source\n')
                elif mutation == 'build-manifest':
                    manifest.write_text('branch build manifest\n')
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
                for mode in ['rtt', 'snapshot', 'store']:
                    result = subprocess.run(['bash', str(spike / 'run.sh'), mode],
                                            capture_output=True, text=True, env=env)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('SPIKE SECURITY BLOCKED:', result.stderr)
                    self.assertFalse((root / '.artifacts').exists())

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
