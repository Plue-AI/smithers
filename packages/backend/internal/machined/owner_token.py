# Host-owned program, invoked by a dropped-uid exec session with -I -S.
# No root execution, imported branch modules, symlink traversal or shell parsing.
import os, sys, stat, re, hashlib, secrets, fcntl
op, uid, session, expected = sys.argv[1:]
uid = int(uid)
assert 20000 <= uid <= 2147483647 and os.getuid() == os.geteuid() == uid
assert op in ('put', 'delete') and re.fullmatch('[a-z0-9][a-z0-9-]{0,63}', session)
assert expected == 'absent' or re.fullmatch('[a-f0-9]{64}', expected)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
parent = os.open('/run', flags)
for name, owner in [('smithers', 0), (str(uid), uid)]:
    child = os.open(name, flags, dir_fd=parent)
    os.close(parent)
    parent = child
    info = os.fstat(parent)
    assert info.st_uid == owner and not info.st_mode & 0o022
    if owner == uid:
        assert stat.S_IMODE(info.st_mode) == 0o700
for name in ['token', 'sessions', session]:
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError:
        pass
    child = os.open(name, flags, dir_fd=parent)
    os.close(parent)
    parent = child
    info = os.fstat(parent)
    assert info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700
fcntl.flock(parent, fcntl.LOCK_EX)
try:
    fd = os.open('token', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
except FileNotFoundError:
    assert expected == 'absent' or op == 'delete'
    current = None
else:
    info = os.fstat(fd)
    assert stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1
    assert stat.S_IMODE(info.st_mode) == 0o600
    current = os.read(fd, 514)
    os.close(fd)
    assert current.endswith(b'\n') and hashlib.sha256(current[:-1]).hexdigest() == expected
if op == 'put':
    body = sys.stdin.buffer.read(513)
    assert 0 < len(body) <= 512 and all(32 < x < 127 for x in body)
    temporary = '.token-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(body + b'\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, 'token', src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
elif current is not None:
    os.unlink('token', dir_fd=parent)
    os.fsync(parent)
os.close(parent)
