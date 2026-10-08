//! Root-only installed process launcher. All paths and child environment are
//! fixed by the shipped image; no repository or home configuration is read.
use super::{
    cgroups::Cgroups,
    control,
    lifecycle::{self, Process},
};
use crate::boot::{Boot, Topology};
use rustix::{
    fs::{Mode, OFlags, ResolveFlags},
    net::{AddressFamily, SocketFlags, SocketType},
};
use std::{
    fs::{self, File},
    io::{self, Write},
    net::TcpListener,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::UnixListener,
            process::CommandExt,
        },
    },
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const EXECUTABLE: &str = "/opt/smithers/bin/smithers-machined";
const CGROUP: &str = "/sys/fs/cgroup/smithers";
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "untrusted process inputs")
}
fn protected(path: &str, directory: bool) -> io::Result<File> {
    let root = File::open("/")?;
    let fd = rustix::fs::openat2(
        &root,
        path.trim_start_matches('/'),
        OFlags::RDONLY
            | OFlags::CLOEXEC
            | OFlags::NONBLOCK
            | if directory {
                OFlags::DIRECTORY
            } else {
                OFlags::empty()
            },
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
    )?;
    let file = File::from(fd);
    let meta = file.metadata()?;
    if meta.uid() != 0
        || meta.mode() & 0o022 != 0
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err(invalid());
    }
    Ok(file)
}
// Retained install inputs are checked on every daemon launch, after the
// session-drain barrier, as well as before the initial broker startup.
fn trusted_startup() -> io::Result<()> {
    for path in [
        "/opt",
        "/opt/smithers",
        "/opt/smithers/bin",
        "/run",
        "/run/smithers",
        "/run/smithers/machined",
    ] {
        protected(path, true)?;
    }
    let executable = protected(EXECUTABLE, false)?;
    let selected = executable.metadata()?;
    let running = File::open("/proc/self/exe")?.metadata()?;
    // The installer pins the running broker's bytes. Linux prevents writes to
    // that executable inode while it runs; a retained path replacement must
    // never select different daemon code, even with plausible owner/mode bits.
    if selected.mode() & 0o6000 != 0
        || selected.dev() != running.dev()
        || selected.ino() != running.ino()
    {
        return Err(invalid());
    }
    super::spawn::daemon_account()?;
    Boot::open()?;
    Ok(())
}
fn high(fd: &impl std::os::fd::AsFd) -> io::Result<OwnedFd> {
    Ok(rustix::io::fcntl_dupfd_cloexec(fd, 10)?)
}
pub struct Installed {
    _lock: File,
    controls:
        super::supervisor::Supervisor<super::spawn::Processes<super::spawn::InstalledAdmission>>,
    local: UnixListener,
    relay: Option<TcpListener>,
}
impl Installed {
    pub fn open() -> io::Result<Self> {
        if rustix::process::geteuid().as_raw() != 0 {
            return Err(invalid());
        }
        trusted_startup()?;
        let root = File::open("/")?;
        let fd = rustix::fs::openat2(
            &root,
            "run/smithers/machined/broker.lock",
            OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )?;
        let lock = File::from(fd);
        let meta = lock.metadata()?;
        if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o7777 != 0o600 || meta.nlink() != 1
        {
            return Err(invalid());
        }
        // One root owner per boot. Never unlink the inode: the installer and
        // broker use the same lock to distinguish retained serving from startup.
        rustix::fs::flock(&lock, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
        // Refuse launching a copy from a branch-controlled directory even if a
        // caller ran it with root. Planting provenance belongs to the runtime.
        if fs::read_link("/proc/self/exe")? != std::path::Path::new(EXECUTABLE) {
            return Err(invalid());
        }
        let boot = Boot::open()?;
        for name in ["", "/broker", "/daemon", "/sessions"] {
            let path = format!("{CGROUP}{name}");
            match fs::create_dir(&path) {
                Ok(()) => (),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(e),
            }
            protected(&path, true)?;
        }
        fs::write(
            format!("{CGROUP}/broker/cgroup.procs"),
            std::process::id().to_string(),
        )?;
        fs::write(format!("{CGROUP}/cgroup.subtree_control"), "+cpu +pids")?;
        let mut controls = Cgroups::open()?;
        controls.recover(Instant::now() + Duration::from_secs(5))?;
        // Verify both required controls before a child can admit sessions.
        File::options()
            .write(true)
            .open(format!("{CGROUP}/sessions/cgroup.kill"))?;
        File::options()
            .write(true)
            .open(format!("{CGROUP}/sessions/cgroup.freeze"))?;
        let path = "/run/smithers/machined.sock";
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_socket() && meta.uid() == 0 => fs::remove_file(path)?,
            Ok(_) => return Err(invalid()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let local = UnixListener::bind(path)?;
        rustix::fs::chown(
            path,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::from_raw(19999)),
        )?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o660))?;
        let relay = match boot.topology {
            Topology::Relay => Some(TcpListener::bind("127.0.0.1:970")?),
            Topology::Bridge(_) => None,
        };
        Ok(Self {
            _lock: lock,
            controls: super::supervisor::Supervisor::new(super::spawn::Processes::new(
                controls,
                super::spawn::InstalledAdmission,
            )),
            local,
            relay,
        })
    }
}
impl Process for Installed {
    fn kill_sessions(&mut self) -> io::Result<()> {
        self.controls.before_restart(Instant::now())
    }
    fn run_daemon(&mut self) -> io::Result<(i32, Duration)> {
        trusted_startup()?;
        for name in ["", "/broker", "/daemon", "/sessions"] {
            protected(&format!("{CGROUP}{name}"), true)?;
        }
        Cgroups::open()?;
        let (parent, child_socket) = rustix::net::socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )?;
        let child = high(&child_socket)?;
        drop(child_socket);
        let local = high(&self.local)?;
        let relay = self.relay.as_ref().map(high).transpose()?;
        let mut procs = File::options()
            .write(true)
            .open(format!("{CGROUP}/daemon/cgroup.procs"))?;
        let mut command = Command::new(EXECUTABLE);
        command
            .arg("daemon")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", "/var/lib/smithers-machined")
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        // SAFETY: the root supervisor is single-threaded; this closure uses only
        // fixed descriptors and syscalls before exec, never branch-derived data.
        unsafe {
            command.pre_exec(move || {
                procs.write_all(
                    rustix::process::getpid()
                        .as_raw_nonzero()
                        .get()
                        .to_string()
                        .as_bytes(),
                )?;
                rustix::thread::set_thread_groups(&[rustix::process::Gid::from_raw(20000)])?;
                let gid = rustix::process::Gid::from_raw(19998);
                rustix::thread::set_thread_res_gid(gid, gid, gid)?;
                let uid = rustix::process::Uid::from_raw(19998);
                rustix::thread::set_thread_res_uid(uid, uid, uid)?;
                rustix::process::umask(Mode::from_raw_mode(0o002));
                rustix::thread::set_no_new_privs(true)?;
                rustix::process::set_dumpable_behavior(
                    rustix::process::DumpableBehavior::NotDumpable,
                )?;
                for (source, destination) in [(child.as_raw_fd(), 3), (local.as_raw_fd(), 5)] {
                    if libc::dup2(source, destination) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                if let Some(relay) = &relay {
                    if libc::dup2(relay.as_raw_fd(), 4) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else {
                    libc::close(4);
                }
                Ok(())
            });
        }
        let start = Instant::now();
        let mut child = command.spawn()?;
        drop(command);
        let served = control::serve(&parent, &mut self.controls);
        if served.is_err() {
            let _ = child.kill();
        }
        let status = child.wait()?;
        Ok((status.code().unwrap_or(137), start.elapsed()))
    }
    fn delay(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
pub fn run() -> io::Result<()> {
    lifecycle::supervise(&mut Installed::open()?)
}
