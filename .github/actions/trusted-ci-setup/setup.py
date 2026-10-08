"""Main-pinned engineering runner setup. No checkout bytes or configurable argv."""
import base64
import hashlib
import json
import urllib.request
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

# T-SEC-01 R1–R3 and smithers-3f's setup campaign acceptance are still pending.
ACTIVATED = False
PACKAGES = ('bubblewrap',)
PATH = '/usr/sbin:/usr/bin:/sbin:/bin'
EXECUTABLES = ('/usr/bin/sudo', '/usr/bin/env', '/usr/bin/apt-get',
               '/usr/sbin/sysctl', '/usr/bin/python3')
FORBIDDEN = ('LD_', 'DYLD_', 'BASH_FUNC_', 'INPUT_')
FORBIDDEN_KEYS = ('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH',
                  'PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'APT_CONFIG',
                  'GH_TOKEN', 'GITHUB_TOKEN', 'SMITHERS_GITHUB_PROXY',
                  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY',
                  'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy')
CANARY = b'smithers-main-pinned-setup-v1\n'
# Ubuntu ubuntu-keyring_2023.11.28.1_all.deb from archive.ubuntu.com.
# Package SHA256: 36de43b15853ccae0028e9a767613770c704833f82586f28eb262f0311adb8a8.
# Root loads these main-pinned bytes, never the image's writable keyring.
KEYRING_SHA256 = '80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31'
KEYRING = base64.b64decode('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')


def refuse(message):
    raise RuntimeError('trusted setup refused: ' + message)


def trusted_path(name, executable=False):
    path = Path(name)
    # Resolve runner-image symlinks, then inspect every destination ancestor.
    for item in (path, *path.parents):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode):
            refuse('untrusted runner path: ' + str(item))
    resolved = path.resolve(strict=True)
    for item in (resolved, *resolved.parents):
        info = item.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            refuse('untrusted runner path: ' + str(item))
    if executable:
        if not os.access(resolved, os.X_OK):
            refuse('non-executable runner path: ' + name)
        # Compare executable bytes with the approved runner's root-owned
        # package inventory, without executing a PATH-selected verifier.
        package = {'sudo': 'sudo', 'env': 'coreutils', 'apt-get': 'apt',
                   'sysctl': 'procps'}.get(path.name, 'python3.12-minimal')
        inventory = '/var/lib/dpkg/info/' + package + '.md5sums'
        trusted_path(inventory)
        candidates = {str(resolved).lstrip('/'), str(path).lstrip('/'),
                      str(path).removeprefix('/usr/').lstrip('/')}
        expected = [line.split()[0] for line in Path(inventory).read_text().splitlines()
                    if len(line.split()) == 2 and line.split()[1] in candidates]
        if len(expected) != 1 or hashlib.md5(resolved.read_bytes()).hexdigest() != expected[0]:
            refuse('runner executable identity: ' + name)


def validate():
    if sys.platform != 'linux' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        refuse('requires a disposable GitHub-hosted Ubuntu runner')
    if os.environ.get('RUNNER_OS') != 'Linux' or os.environ.get('ImageOS') != 'ubuntu24':
        refuse('requires the approved Ubuntu 24 runner image')
    try:
        inputs = json.loads(os.environ.get('SMITHERS_TRUSTED_SETUP_INPUTS', '{}'))
    except ValueError:
        refuse('action inputs')
    if inputs != {}:
        refuse('action inputs')
    for key in os.environ:
        if key in FORBIDDEN_KEYS or key.startswith(FORBIDDEN):
            refuse('environment: ' + key)
    # PATH is never searched, even before privilege escalation. Refuse paths
    # outside the image, including action state and a checkout's executable bin.
    if os.environ.get('SMITHERS_TRUSTED_INCOMING_PATH', '') not in ('', PATH):
        refuse('PATH')
    for component in os.environ.get('PATH', '').split(':'):
        if not component or not component.startswith(('/usr/', '/bin', '/sbin', '/opt/')):
            refuse('PATH')
        trusted_path(component)
    for name in EXECUTABLES:
        trusted_path(name, executable=True)
    # Hosted image keyrings can be runner-owned. Verify their exact approved
    # bytes, but never hand that mutable path to apt under root.
    trusted_path('/usr/share/keyrings')
    image_keyring = Path('/usr/share/keyrings/ubuntu-archive-keyring.gpg').read_bytes()
    if hashlib.sha256(image_keyring).hexdigest() != KEYRING_SHA256:
        refuse('runner keyring identity')
    # An engineering checkout must not have been populated before setup.
    workspace = Path(os.environ['GITHUB_WORKSPACE'])
    if workspace.exists() and any(workspace.iterdir()):
        refuse('setup must precede checkout')
    if Path.cwd() not in (Path('/'), workspace.resolve()):
        refuse('working directory')
    for key in ('GITHUB_ENV', 'GITHUB_PATH'):
        state = os.environ.get(key)
        if state and Path(state).exists() and Path(state).read_bytes():
            refuse('action state: ' + key)
    if Path.home().joinpath('.config/issue-claim').exists():
        refuse('publication credential store')
    for name in ('/etc/apt', '/etc/apt/apt.conf.d', '/etc/apt/sources.list.d'):
        trusted_path(name)
    # Config below does not load these files. Still refuse branch-writable
    # apt state before invoking any privileged executable.
    for directory in ('/etc/apt/apt.conf.d', '/etc/apt/sources.list.d'):
        for item in Path(directory).iterdir():
            trusted_path(str(item))
    # Independently verify that GitHub supplied this action at a full main
    # ancestor SHA. A branch PACKAGE.ts or edited workflow cannot attest it.
    revision = os.environ.get('SMITHERS_TRUSTED_ACTION_REF', '')
    if (os.environ.get('SMITHERS_TRUSTED_ACTION_REPOSITORY') != 'smithersai/smithers'
            or len(revision) != 40 or any(c not in '0123456789abcdef' for c in revision)):
        refuse('main-pinned action source')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        'https://api.github.com/repos/smithersai/smithers/compare/' + revision + '...main',
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'smithers-trusted-setup'})
    with opener.open(request, timeout=30) as response:
        comparison = json.load(response)
    if comparison.get('status') not in ('ahead', 'identical'):
        refuse('action revision is not on main')
    source = urllib.request.Request(
        'https://raw.githubusercontent.com/smithersai/smithers/' + revision +
        '/.github/actions/trusted-ci-setup/setup.py',
        headers={'User-Agent': 'smithers-trusted-setup'})
    with opener.open(source, timeout=30) as response:
        expected = hashlib.sha256(response.read()).digest()
    if hashlib.sha256(Path(__file__).read_bytes()).digest() != expected:
        refuse('main-pinned setup byte identity')


def root_setup():
    if os.geteuid() != 0:
        refuse('root entry requires root')
    # Root creates all apt input bytes; no user-owned temporary file is loaded.
    with tempfile.TemporaryDirectory(prefix='smithers-trusted-', dir='/run') as directory:
        root = Path(directory)
        keyring = root / 'archive-keyring.gpg'
        if hashlib.sha256(KEYRING).hexdigest() != KEYRING_SHA256:
            refuse('main-pinned keyring identity')
        keyring.write_bytes(KEYRING)
        keyring.chmod(0o644)
        # apt drops signature verification to _apt; keep only this immutable
        # root-owned directory readable while setup runs.
        root.chmod(0o755)
        sources = root / 'sources.list'
        sources.write_text(f'deb [signed-by={keyring}] https://archive.ubuntu.com/ubuntu noble main universe\n'
                           f'deb [signed-by={keyring}] https://archive.ubuntu.com/ubuntu noble-updates main universe\n'
                           f'deb [signed-by={keyring}] https://security.ubuntu.com/ubuntu noble-security main universe\n')
        config = root / 'apt.conf'
        config.write_text('Dir::Etc::main "/dev/null";\nDir::Etc::parts "-";\n'
                          'Dir::Etc::sourceparts "-";\n'
                          f'Dir::Etc::sourcelist "{sources}";\n')
        environment = {'PATH': PATH, 'HOME': '/root', 'LANG': 'C.UTF-8',
                       'DEBIAN_FRONTEND': 'noninteractive', 'APT_CONFIG': str(config)}
        commands = [['/usr/bin/apt-get', 'update'],
                    ['/usr/bin/apt-get', 'install', '--yes', '--no-install-recommends', *PACKAGES]]
        for command in commands:
            subprocess.run(command, env=environment, cwd='/', check=True)
        if Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').exists():
            command = ['/usr/sbin/sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0']
            subprocess.run(command, env={'PATH': PATH, 'HOME': '/root', 'LANG': 'C.UTF-8'}, cwd='/', check=True)
            commands.append(command)
        Path('/run/smithers-trusted-setup.receipt').write_bytes(CANARY)
        print('TRUSTED-SETUP-COMMANDS ' + json.dumps(commands), flush=True)


def dispatch(activated=ACTIVATED):
    validate()
    if not activated:
        refuse('T-SEC-01 receipts and setup campaign acceptance pending')
    # Only main-pinned action bytes are re-entered. No shell, PATH search,
    # branch dependency, user-selected package, destination or sysctl exists.
    subprocess.run(['/usr/bin/sudo', '--non-interactive', '/usr/bin/env', '-i',
                    'PATH=' + PATH, 'HOME=/root', 'LANG=C.UTF-8',
                    '/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--root'],
                   cwd='/', check=True)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--root']:
            root_setup()
        elif sys.argv[1:] == ['--validate']:
            validate()
        elif not sys.argv[1:]:
            dispatch()
        else:
            refuse('argv')
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
