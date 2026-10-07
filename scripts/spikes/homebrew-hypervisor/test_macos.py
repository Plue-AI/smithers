"""Real C-SPK-06 boundaries. Never substitutes a fake CLI for boot evidence."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

from preflight import IMAGE, digest, git, validate


@unittest.skipUnless(sys.platform == 'darwin', 'requires fresh macOS GUI user and Homebrew')
class HomebrewEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[3]
        cls.bundle = Path(os.environ['C_SPK_06_BUNDLE']).resolve(strict=True)
        cls.inventory = validate(cls.root, cls.bundle)
        cls.inventory['harness_commit'] = git(cls.root, 'rev-parse', 'HEAD')
        if os.getuid() == 0:
            raise RuntimeError('installing user must be unprivileged')
        cls.brew = Path('/opt/homebrew/bin/brew')
        cls.evidence = cls.root / '.artifacts/checks/C-SPK-06' / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        cls.evidence.mkdir(parents=True)
        cls.work = Path(tempfile.mkdtemp(prefix='smithers-spike-'))
        cls.counter = 0
        cls.command(['/usr/bin/sw_vers'])
        if int(cls.command(['/usr/bin/sw_vers', '-productVersion']).strip().split('.')[0]) < 15:
            raise RuntimeError('macOS 15 or later required')
        if cls.command(['/usr/bin/uname', '-m']).strip() != 'arm64':
            raise RuntimeError('Apple Silicon reference host required')
        cls.command([str(cls.brew), '--version'])
        cls.command(['/usr/bin/id'])
        (cls.evidence / 'inputs.json').write_text(json.dumps(cls.inventory, sort_keys=True))
        cls.command([str(cls.brew), 'tap-new', 'smithers-spike/tap'])
        tap = Path(cls.command([str(cls.brew), '--repository', 'smithers-spike/tap']).strip())
        archive = cls.work / 'bundle.tar.gz'
        with tarfile.open(archive, 'w:gz') as out:
            for path in cls.bundle.iterdir():
                out.add(path, arcname=path.name)
        formula = '''class SmithersSpike < Formula
  desc "Disposable signing evidence"
  homepage "https://github.com/smithersai/smithers"
  url "file://%s"
  sha256 "%s"
  version "0.6.16"
  def install
    prefix.install Dir["*"]
    system "/usr/bin/codesign", "--remove-signature", lib/"libkrunfw.5.dylib"
    File.write("msb.entitlements", '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>')
    system "/usr/bin/codesign", "--force", "--sign", "-", "--entitlements", "msb.entitlements", bin/"msb"
  end
end
''' % (archive, digest(archive))
        (tap / 'Formula/smithers-spike.rb').write_text(formula)
        (cls.evidence / 'smithers-spike.rb').write_text(formula)

    @classmethod
    def command(cls, argv, env=None, allow_failure=False):
        cls.counter += 1
        environment = {'HOME': str(Path.home()), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOMEBREW_NO_AUTO_UPDATE': '1', **(env or {})}
        started = time.monotonic()
        result = subprocess.run(argv, env=environment, cwd=cls.work, input='', text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
        log = cls.evidence / ('%03d.log' % cls.counter)
        log.write_text(result.stdout)
        (cls.evidence / ('%03d.json' % cls.counter)).write_text(json.dumps({'argv': argv, 'env': environment, 'cwd': str(cls.work), 'uid': os.getuid(), 'seconds': time.monotonic()-started, 'exit': result.returncode, 'logSHA256': digest(log)}))
        if result.returncode and not allow_failure:
            raise RuntimeError('command failed; retained evidence: ' + str(log))
        return result.stdout

    def probe(self, keg, label):
        for name in ('bin/smithers-backend', 'share/microsandbox/base-image.oci.tar', 'share/microsandbox/base-image.json'):
            self.assertEqual(digest(keg / name), self.inventory['artifacts'][name], 'installed root input changed: ' + name)
        msb = str(keg / 'bin/msb')
        (self.evidence / (label + '-installed-hashes.json')).write_text(json.dumps({name: digest(keg / name) for name in ('bin/msb', 'bin/smithers-backend', 'lib/libkrunfw.5.dylib', 'share/microsandbox/base-image.oci.tar')}))
        self.assertRegex(self.command([msb, '--version']), r'(?m)^(?:msb |microsandbox )?0\.6\.16\s*$')
        self.command(['/usr/bin/codesign', '-dvv', msb])
        entitlements = self.command(['/usr/bin/codesign', '-d', '--entitlements', ':-', msb])
        self.assertIn('com.apple.security.hypervisor', entitlements)
        self.command(['/usr/bin/xattr', '-l', msb])
        self.command(['/usr/bin/codesign', '-dvv', str(keg / 'lib/libkrunfw.5.dylib')], allow_failure=True)
        self.command(['/usr/bin/xattr', '-l', str(keg / 'lib/libkrunfw.5.dylib')])
        home = self.work / label
        home.mkdir()
        # Literal root inputs: no mounts, network, caller command or retained machine.
        commands = [
            [msb, 'image', 'load', '--input', str(keg / 'share/microsandbox/base-image.oci.tar'), '--tag', IMAGE],
            [msb, 'create', IMAGE, '--pull', 'never', '--name', 'c-spk-06', '--memory', '1G', '--cpus', '1', '--root-disk', '2G', '--no-net'],
            [msb, 'exec', '--stream', 'c-spk-06', '--', '/bin/sh', '-c', 'echo ok'],
            [str(keg / 'bin/smithers-backend'), 'microvm', 'doctor'],
            [msb, 'stop', '-t', '10', '-q', 'c-spk-06'],
        ]
        env = {'HOME': str(home), 'MSB_BACKEND': 'local', 'SMITHERS_DATA_ROOT': str(home / 'data')}
        for index, command in enumerate(commands):
            output = self.command(command, env)
            if index == 2:
                self.assertEqual(output.strip(), 'ok')
                processes = self.command(['/bin/ps', '-axo', 'uid,pid,command'])
                self.assertIn(msb, processes)
                loaded = self.command(['/usr/sbin/lsof', '-Fn', str(keg / 'lib/libkrunfw.5.dylib')])
                paths = [Path(line[1:]).resolve() for line in loaded.splitlines() if line.startswith('n')]
                self.assertTrue(paths)
                self.assertTrue(all(path.is_relative_to(keg.resolve()) for path in paths))
        # Run the same literal commands in the installing user's real GUI domain.
        import shlex
        script = self.work / (label + '.sh')
        gui_home = self.work / (label + '-gui-home')
        gui_home.mkdir()
        env = {**env, 'HOME': str(gui_home), 'SMITHERS_DATA_ROOT': str(gui_home / 'data')}
        gui_commands = [[msb, '--version'], ['/usr/bin/codesign', '-d', '--entitlements', ':-', msb], *commands[:-1], ['/bin/ps', '-axo', 'uid,pid,command'], ['/usr/sbin/lsof', '-Fn', str(keg / 'lib/libkrunfw.5.dylib')], commands[-1]]
        script.write_text('#!/bin/bash\nset -euo pipefail\n' + '\n'.join('env -i ' + ' '.join(shlex.quote(k+'='+v) for k,v in env.items()) + ' PATH=/usr/bin:/bin:/usr/sbin:/sbin ' + shlex.join(command) for command in gui_commands) + '\n')
        script.chmod(0o700)
        shutil.copy2(script, self.evidence / script.name)
        agent = 'ai.smithers.spike.' + label
        log = self.evidence / (label + '-gui.log')
        plist = self.work / (label + '.plist')
        plist.write_bytes(plistlib.dumps({'Label': agent, 'ProgramArguments': ['/bin/bash', str(script)], 'RunAtLoad': True, 'StandardOutPath': str(log), 'StandardErrorPath': str(log)}))
        shutil.copy2(plist, self.evidence / plist.name)
        domain = 'gui/' + str(os.getuid())
        self.command(['/bin/launchctl', 'bootstrap', domain, str(plist)])
        try:
            for _ in range(120):
                state = self.command(['/bin/launchctl', 'print', domain+'/'+agent])
                if 'last exit code = ' in state:
                    self.assertIn('last exit code = 0', state)
                    gui_output = log.read_text()
                    self.assertIn('ok', gui_output.splitlines())
                    self.assertIn('com.apple.security.hypervisor', gui_output)
                    library_paths = [Path(line[1:]).resolve() for line in gui_output.splitlines() if line.startswith('n/') ]
                    self.assertTrue(library_paths)
                    self.assertTrue(all(path.is_relative_to(keg.resolve()) for path in library_paths))
                    (self.evidence / (label + '-gui-log.json')).write_text(json.dumps({'logSHA256': digest(log), 'uid': os.getuid()}))
                    break
                time.sleep(1)
            else:
                self.fail('GUI agent did not finish')
        finally:
            self.command(['/bin/launchctl', 'bootout', domain+'/'+agent])

    def test_TestHomebrewSigningAndGUIBoot(self):
        self.command([str(self.brew), 'install', '--formula', 'smithers-spike/tap/smithers-spike'])
        keg = Path(self.command([str(self.brew), '--prefix', 'smithers-spike']).strip()).resolve()
        failures = {}
        try:
            self.probe(keg, 'A')
        except (AssertionError, RuntimeError) as error:
            failures['A'] = str(error)
        self.command([str(self.brew), 'uninstall', 'smithers-spike'])
        self.command([str(self.brew), 'install', '--build-bottle', 'smithers-spike/tap/smithers-spike'])
        self.command([str(self.brew), 'bottle', '--json', 'smithers-spike'])
        bottles = list(self.work.glob('*.bottle.tar.gz'))
        self.assertEqual(len(bottles), 1)
        (self.evidence / 'bottle-hash.json').write_text(json.dumps({'file': bottles[0].name, 'sha256': digest(bottles[0])}))
        for metadata in self.work.glob('*.bottle.json'):
            shutil.copy2(metadata, self.evidence / metadata.name)
        self.command([str(self.brew), 'uninstall', 'smithers-spike'])
        self.command([str(self.brew), 'install', str(bottles[0])])
        try:
            self.probe(keg, 'B')
        except (AssertionError, RuntimeError) as error:
            failures['B'] = str(error)
        (self.evidence / 'variants.json').write_text(json.dumps({'failures': failures, 'selected': None}))
        self.assertFalse(failures, 'variant failure evidence retained; owners must select a tested alternative')

    def test_TestHomebrewKegRelocation(self):
        keg = Path(self.command([str(self.brew), '--prefix', 'smithers-spike']).strip()).resolve()
        relocated = self.work / 'relocated-keg'
        shutil.move(str(keg), relocated)
        try:
            self.probe(relocated, 'relocated')
        finally:
            shutil.move(str(relocated), keg)
