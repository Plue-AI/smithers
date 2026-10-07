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
    if !directory {
        validate_device(&fd, path)?;
    }
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
fn validate_device(fd: &OwnedFd, path: &CStr) -> io::Result<()> {
    let expected = match path.to_bytes() {
        b"/dev/null" => libc::makedev(1, 3),
        b"/dev/zero" => libc::makedev(1, 5),
        b"/dev/tty" => libc::makedev(5, 0),
        _ => return Err(io::Error::from(io::ErrorKind::PermissionDenied)),
    };
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(errno());
    }
    let info = unsafe { info.assume_init() };
    if info.st_uid != 0 || info.st_mode & libc::S_IFMT != libc::S_IFCHR || info.st_rdev != expected
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(())
}
#[repr(C)]
struct MountAttributes {
    set: u64,
    clear: u64,
    propagation: u64,
    user_namespace: u64,
}

fn mount_attributes(path: &CStr, recursive: bool, writable: bool) -> io::Result<()> {
    let attr = MountAttributes {
        set: if writable { 0 } else { 1 }, // MOUNT_ATTR_RDONLY
        clear: if writable { 1 } else { 0 },
        propagation: 0,
        user_namespace: 0,
    };
    let flags = libc::AT_SYMLINK_NOFOLLOW | if recursive { 0x8000 } else { 0 }; // AT_RECURSIVE
    if unsafe {
        libc::syscall(
            libc::SYS_mount_setattr,
            libc::AT_FDCWD,
            path.as_ptr(),
            flags,
            &attr,
            std::mem::size_of::<MountAttributes>(),
        )
    } != 0
    {
        return Err(errno());
    }
    Ok(())
}

// Landlock does not restrict chmod/chown/timestamps. A private read-only mount
// view additionally confines metadata mutations while keeping workspace/home
// writable. All inputs are fixed installed paths, before applying member data.
fn mount_view(workspace: &CStr, home: &CStr) -> io::Result<()> {
    if unsafe { libc::unshare(libc::CLONE_NEWNS) } != 0 {
        return Err(errno());
    }
    if unsafe {
        libc::mount(
            std::ptr::null(),
            c"/".as_ptr(),
            std::ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            std::ptr::null(),
        )
    } != 0
    {
        return Err(errno());
    }
    for path in [workspace, home] {
        // Reject symlinks before creating the writable exception. Production
        // parents / and /home are root-owned and not member-writable.
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(errno());
        }
        let _held = unsafe { OwnedFd::from_raw_fd(fd) };
        if unsafe {
            libc::mount(
                path.as_ptr(),
                path.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND | libc::MS_REC,
                std::ptr::null(),
            )
        } != 0
        {
            return Err(errno());
        }
    }
    mount_attributes(c"/", true, false)?;
    for path in [workspace, home] {
        // Only the exception's top mount becomes writable; nested mounts stay
        // read-only, including any aliases to the host/guest control filesystem.
        mount_attributes(path, false, true)?;
    }
    Ok(())
}

/// Call only in the root child with fixed identity before dropping credentials.
/// Errors stop spawn; no unsupported-kernel or permission fallback exists.
pub fn prepare_mounts(home: &CStr) -> io::Result<()> {
    if ![b"/home/ben".as_slice(), b"/home/agent".as_slice()].contains(&home.to_bytes()) {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    mount_view(c"/workspace", home)
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
    fn mount_view_confines_metadata_on_the_real_kernel() {
        // A user namespace maps virtual root to this unprivileged host UID.
        // No prototype root code is installed or run with host root authority.
        const CHILD: &str = "TRM06_MOUNT_PROBE";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = std::path::PathBuf::from(root);
            let workspace =
                std::ffi::CString::new(root.join("workspace").as_os_str().as_encoded_bytes())
                    .unwrap();
            let home =
                std::ffi::CString::new(root.join("home").as_os_str().as_encoded_bytes()).unwrap();
            mount_view(&workspace, &home).unwrap();
            use std::os::unix::fs::PermissionsExt;
            let outside = root.join("outside");
            assert_eq!(
                std::fs::write(&outside, b"changed")
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EROFS)
            );
            assert_eq!(
                std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o777))
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EROFS)
            );
            for directory in ["workspace", "home"] {
                let file = root.join(directory).join("permitted");
                std::fs::write(&file, b"permitted").unwrap();
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
                assert_eq!(std::fs::read(file).unwrap(), b"permitted");
            }
            assert!(std::fs::rename(root.join("workspace/permitted"), &outside).is_err());
            // Exercise actual OpenSSH SFTP metadata requests in this same
            // kernel view. This is a subsystem control, not installed SSH/relay
            // or root authority evidence.
            use std::io::{Read, Write};
            let mut sftp = Command::new("/usr/lib/openssh/sftp-server")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut input = sftp.stdin.take().unwrap();
            let mut output = sftp.stdout.take().unwrap();
            input.write_all(&[0, 0, 0, 5, 1, 0, 0, 0, 3]).unwrap();
            fn packet(output: &mut impl Read) -> Vec<u8> {
                let mut length = [0; 4];
                output.read_exact(&mut length).unwrap();
                let length = u32::from_be_bytes(length) as usize;
                assert!(length <= 65536);
                let mut body = vec![0; length];
                output.read_exact(&mut body).unwrap();
                body
            }
            assert_eq!(packet(&mut output)[0], 2);
            for (id, path, expected) in [
                (1u32, outside.clone(), 4u32),
                (2, root.join("home/permitted"), 0),
            ] {
                let path = path.as_os_str().as_encoded_bytes();
                let mut body = vec![9]; // SSH_FXP_SETSTAT, permissions only
                body.extend_from_slice(&id.to_be_bytes());
                body.extend_from_slice(&(path.len() as u32).to_be_bytes());
                body.extend_from_slice(path);
                body.extend_from_slice(&4u32.to_be_bytes());
                body.extend_from_slice(&0o600u32.to_be_bytes());
                input.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
                input.write_all(&body).unwrap();
                let reply = packet(&mut output);
                assert_eq!(reply[0], 101);
                assert_eq!(&reply[1..5], &id.to_be_bytes());
                assert_eq!(&reply[5..9], &expected.to_be_bytes());
            }
            drop(input);
            assert!(sftp.wait().unwrap().success());

            return;
        }
        let root = std::env::temp_dir().join(format!("trm06-mount-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        for name in ["workspace", "home"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        std::fs::write(root.join("outside"), b"outside-fixture").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.join("outside"), std::fs::Permissions::from_mode(0o640))
            .unwrap();
        let result = Command::new("/usr/bin/unshare")
            .args(["--user", "--map-root-user", "--mount"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "confinement::tests::mount_view_confines_metadata_on_the_real_kernel",
                "--nocapture",
            ])
            .env(CHILD, &root)
            .output()
            .unwrap();
        let bytes = std::fs::read(root.join("outside")).unwrap();
        let mode = std::fs::metadata(root.join("outside"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            result.status.success(),
            "namespace probe: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(bytes, b"outside-fixture");
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn device_exceptions_validate_the_held_object() {
        let null = std::fs::File::open("/dev/null").unwrap();
        let null = OwnedFd::from(null);
        validate_device(&null, c"/dev/null").unwrap();
        assert!(validate_device(&null, c"/dev/zero").is_err());
        assert!(validate_device(&null, c"/dev/tty").is_err());
        assert!(validate_device(&null, c"/tmp/device").is_err());
        let ordinary = OwnedFd::from(std::fs::File::open("/etc/passwd").unwrap());
        assert!(validate_device(&ordinary, c"/dev/null").is_err());
    }
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
