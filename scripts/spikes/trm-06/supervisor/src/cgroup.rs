//! Port of the guest helper's held-descriptor cleanup, with a shared 2 s
//! startup barrier. No helper subprocess, path-based kill or ignored kill error.
//! Not activated until installed provenance and real root validation exist.
use crate::cgroup_policy::{empty, name_valid};
use crate::drain::{Observation, drain};
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

fn refusal() -> io::Error {
    io::Error::other("untrusted session cgroup")
}
fn open_at(parent: RawFd, name: &str, flags: i32) -> io::Result<OwnedFd> {
    let name = CString::new(name).map_err(|_| refusal())?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn directory(parent: RawFd, name: &str) -> io::Result<OwnedFd> {
    let fd = open_at(parent, name, libc::O_RDONLY | libc::O_DIRECTORY)?;
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    if info.st_uid != 0 || info.st_mode & 0o022 != 0 {
        return Err(refusal());
    }
    Ok(fd)
}
pub struct Sessions {
    parent: OwnedFd,
}
impl Sessions {
    /// Resolve every fixed ancestor without symlinks; require cgroup v2.
    /// This code neither creates directories nor consumes branch paths.
    pub fn open() -> io::Result<Self> {
        if unsafe { libc::geteuid() } != 0 {
            return Err(refusal());
        }
        let mut fd = directory(libc::AT_FDCWD, "/")?;
        for component in ["sys", "fs", "cgroup", "smithers", "sessions"] {
            fd = directory(fd.as_raw_fd(), component)?;
        }
        let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(fd.as_raw_fd(), info.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { info.assume_init() }.f_type != 0x6367_7270 {
            return Err(refusal());
        }
        Ok(Self { parent: fd })
    }
    /// Kill all children before polling any. One deadline bounds the whole
    /// barrier rather than giving each orphan another independent timeout.
    pub fn startup_barrier(&self) -> io::Result<()> {
        let started = Instant::now();
        let mut children = Vec::new();
        // /proc/self/fd targets the held, already validated parent, not a
        // re-resolved member-controlled path. No child path is followed.
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", self.parent.as_raw_fd()))? {
            let name = entry?.file_name().into_string().map_err(|_| refusal())?;
            if !entry_is_directory(self.parent.as_raw_fd(), &name)? {
                continue;
            }
            if !name_valid(&name) {
                return Err(refusal());
            }
            children.push(directory(self.parent.as_raw_fd(), &name)?);
        }
        drain(&mut Handles { children, started }, Duration::from_secs(2))
    }
}
fn entry_is_directory(parent: RawFd, name: &str) -> io::Result<bool> {
    let name = CString::new(name).map_err(|_| refusal())?;
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            info.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    if info.st_mode & libc::S_IFMT == libc::S_IFLNK {
        return Err(refusal());
    }
    Ok(info.st_mode & libc::S_IFMT == libc::S_IFDIR)
}

// The policy owns ordering/deadlines; this adapter alone reads kernel files.
struct Handles {
    children: Vec<OwnedFd>,
    started: Instant,
}
impl Observation for Handles {
    fn count(&self) -> usize {
        self.children.len()
    }
    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    fn kill(&mut self, index: usize) -> io::Result<()> {
        let fd = open_at(
            self.children[index].as_raw_fd(),
            "cgroup.kill",
            libc::O_WRONLY,
        )?;
        File::from(fd).write_all(b"1")
    }
    fn empty(&mut self, index: usize) -> io::Result<bool> {
        let fd = open_at(
            self.children[index].as_raw_fd(),
            "cgroup.events",
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        let mut bytes = vec![];
        File::from(fd).take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(refusal());
        }
        empty(std::str::from_utf8(&bytes).map_err(|_| refusal())?)
    }
    fn wait(&mut self) {
        std::thread::sleep(Duration::from_millis(10));
    }
}
