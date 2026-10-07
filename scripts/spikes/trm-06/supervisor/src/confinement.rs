//! Write confinement for the spike's root-session-input-validation. UID drop
//! alone does not protect world-writable directories outside workspace/home.
//! Landlock ABI >=3 is required; unsupported kernels refuse, never fall back.
use std::ffi::CStr;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
const WRITE: u64 = (1 << 1)
    | (1 << 4)
    | (1 << 5)
    | (1 << 6)
    | (1 << 7)
    | (1 << 8)
    | (1 << 9)
    | (1 << 10)
    | (1 << 11)
    | (1 << 12)
    | (1 << 13)
    | (1 << 14);
#[repr(C)]
struct Ruleset {
    handled: u64,
}
#[repr(C, packed)]
struct Beneath {
    allowed: u64,
    parent: i32,
}
fn errno() -> io::Error {
    io::Error::last_os_error()
}
fn scope(ruleset: &OwnedFd, path: &CStr, allowed: u64, directory: bool) -> io::Result<()> {
    let flags = libc::O_PATH
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::open(path.as_ptr(), flags) };
    if fd < 0 {
        return Err(errno());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let rule = Beneath {
        allowed,
        parent: fd.as_raw_fd(),
    };
    if unsafe {
        libc::syscall(
            libc::SYS_landlock_add_rule,
            ruleset.as_raw_fd(),
            1,
            &rule,
            0,
        )
    } != 0
    {
        return Err(errno());
    }
    Ok(())
}
/// Call in the dropped, single-threaded child before cwd, exec or member I/O.
/// Only fixed directories and kernel sink devices are exceptions. Already open
/// PTY/pipe descriptors keep working; no writable cgroup descriptor survives exec.
pub fn restrict(home: &CStr) -> io::Result<()> {
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<u8>(),
            0,
            1,
        )
    };
    if abi < 3 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Landlock ABI 3 required",
        ));
    }
    let attr = Ruleset { handled: WRITE };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr,
            std::mem::size_of::<Ruleset>(),
            0,
        )
    };
    if fd < 0 {
        return Err(errno());
    }
    let ruleset = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    scope(&ruleset, c"/workspace", WRITE, true)?;
    scope(&ruleset, home, WRITE, true)?;
    // These root-owned device nodes hold no repository or other member bytes.
    // They are fixed installed-image inputs in the reference-host matrix.
    for path in [c"/dev/null", c"/dev/zero", c"/dev/tty"] {
        scope(&ruleset, path, 1 << 1, false)?;
    }
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(errno());
    }
    if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0) } != 0 {
        return Err(errno());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    #[test]
    fn missing_fixed_scope_refuses_before_member_command() {
        let mut child = Command::new("/bin/sh");
        child.args(["-c", "exit 7"]);
        unsafe {
            child.pre_exec(|| restrict(c"/nonexistent-trm06-home"));
        }
        assert!(child.spawn().is_err());
    }
}
