"""Main-pinned engineering runner setup. No checkout bytes or configurable argv."""
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
    trusted_path('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
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
        sources = root / 'sources.list'
        sources.write_text('deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main universe\n'
                           'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main universe\n'
                           'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main universe\n')
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
