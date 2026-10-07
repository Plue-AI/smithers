//! Fixed fresh-image provisioning. Called only by an installed-main init
//! provider after source and receipt validation, never by branch main/launcher.
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Command;
fn refused() -> io::Error {
    io::Error::other("prototype account/image state refused")
}
fn directory(parent: i32, name: &str) -> io::Result<OwnedFd> {
    let name = CString::new(name).map_err(|_| refused())?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_uid != 0 || stat.st_mode & 0o022 != 0 {
        return Err(refused());
    }
    Ok(fd)
}
fn records(etc: &OwnedFd, name: &str) -> io::Result<String> {
    let name = CString::new(name).unwrap();
    let fd = unsafe {
        libc::openat(
            etc.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_uid != 0 || stat.st_mode & 0o022 != 0 || stat.st_mode & libc::S_IFMT != libc::S_IFREG
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    File::from(fd).take(1048577).read_to_end(&mut bytes)?;
    if bytes.len() > 1048576 {
        return Err(refused());
    }
    String::from_utf8(bytes).map_err(|_| refused())
}
fn account(text: &str, login: &str, uid: u32, passwd: bool) -> io::Result<bool> {
    let mut present = false;
    for line in text.lines() {
        let fields: Vec<_> = line.split(':').collect();
        if fields.len() != if passwd { 7 } else { 4 } {
            return Err(refused());
        }
        let id = fields[2].parse::<u32>().map_err(|_| refused())?;
        if fields[0] == login || id == uid {
            if present || fields[0] != login || id != uid {
                return Err(refused());
            }
            if passwd
                && (fields[3] != uid.to_string()
                    || fields[5] != format!("/home/{login}")
                    || fields[6] != "/bin/sh")
            {
                return Err(refused());
            }
            present = true;
        }
    }
    Ok(present)
}
fn command(program: &str, args: &[&str]) -> io::Result<()> {
    // Absolute base-image commands with empty startup environment. No branch
    // toolchain/index, HOME links, shell, PATH or Python import path is used.
    let status = Command::new(program)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .current_dir("/")
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(refused())
    }
}
fn home(parent: &OwnedFd, login: &str, uid: u32) -> io::Result<()> {
    let name = CString::new(login).unwrap();
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = directory(parent.as_raw_fd(), login)?;
    if unsafe { libc::fchown(fd.as_raw_fd(), uid, uid) } != 0
        || unsafe { libc::fchmod(fd.as_raw_fd(), 0o700) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
/// Fresh images only: existing member homes are refused rather than traversed
/// or repaired by root. Restart invokes only cgroup cleanup, never this setup.
pub fn provision_fresh() -> io::Result<()> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
        return Err(refused());
    }
    let root = directory(libc::AT_FDCWD, "/")?;
    let etc = directory(root.as_raw_fd(), "etc")?;
    let homes = directory(root.as_raw_fd(), "home")?;
    let group = records(&etc, "group")?;
    let passwd = records(&etc, "passwd")?;
    // Validate all identities before the first root account mutation.
    let mut groups = Vec::new();
    let mut users = Vec::new();
    for (login, id) in [("team", 20000), ("ben", 20001), ("agent", 19999)] {
        if !account(&group, login, id, false)? {
            groups.push((login, id));
        }
        if login != "team" && !account(&passwd, login, id, true)? {
            users.push((login, id));
        }
    }
    // Fresh-home refusal happens before any account mutation, including
    // symlink/replaced-home fixtures. Never recursively repair retained data.
    for login in ["ben", "agent"] {
        let name = CString::new(login).unwrap();
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                homes.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Err(refused());
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
            return Err(io::Error::last_os_error());
        }
    }
    for (login, id) in groups {
        command("/usr/sbin/groupadd", &["-g", &id.to_string(), login])?;
    }
    for (login, id) in users {
        command(
            "/usr/sbin/useradd",
            &[
                "-M",
                "-u",
                &id.to_string(),
                "-g",
                &id.to_string(),
                "-G",
                "20000",
                "-d",
                &format!("/home/{login}"),
                "-s",
                "/bin/sh",
                login,
            ],
        )?;
    }
    // Re-read fixed records independently of command exit status.
    let passwd = records(&etc, "passwd")?;
    let group = records(&etc, "group")?;
    for (login, id) in [("ben", 20001), ("agent", 19999)] {
        if !account(&passwd, login, id, true)? || !account(&group, login, id, false)? {
            return Err(refused());
        }
        home(&homes, login, id)?;
    }
    // Fixed top-level workspace is initialized before branch content arrives.
    let workspace = directory(root.as_raw_fd(), "workspace")?;
    if unsafe { libc::fchown(workspace.as_raw_fd(), 0, 20000) } != 0
        || unsafe { libc::fchmod(workspace.as_raw_fd(), 0o2775) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut cg = directory(root.as_raw_fd(), "sys")?;
    for name in ["fs", "cgroup"] {
        cg = directory(cg.as_raw_fd(), name)?;
    }
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(cg.as_raw_fd(), stat.as_mut_ptr()) } != 0
        || unsafe { stat.assume_init() }.f_type != 0x6367_7270
    {
        return Err(refused());
    }
    for name in ["smithers", "sessions"] {
        let component = CString::new(name).unwrap();
        if unsafe { libc::mkdirat(cg.as_raw_fd(), component.as_ptr(), 0o755) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(io::Error::last_os_error());
        }
        cg = directory(cg.as_raw_fd(), name)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_account_bindings_refuse_aliases_duplicates_and_mismatched_home() {
        assert!(account("ben:x:20001:20001::/home/ben:/bin/sh\n", "ben", 20001, true).unwrap());
        assert!(!account("root:x:0:0::/root:/bin/sh\n", "ben", 20001, true).unwrap());
        for text in [
            "ben:x:0:0::/root:/bin/sh",
            "other:x:20001:20001::/home/other:/bin/sh",
            "ben:x:20001:20001::/home/agent:/bin/sh",
            "ben:x:20001:20001::/home/ben:/bin/sh\nben:x:20001:20001::/home/ben:/bin/sh",
            "ben:x:20001:19999::/home/ben:/bin/sh",
        ] {
            assert!(account(text, "ben", 20001, true).is_err());
        }
        assert!(account("ben:x:20001:", "ben", 20001, false).unwrap());
    }
    #[test]
    fn unprivileged_setup_refuses_before_any_account_command() {
        assert_ne!(unsafe { libc::geteuid() }, 0);
        assert!(provision_fresh().is_err());
    }
}
