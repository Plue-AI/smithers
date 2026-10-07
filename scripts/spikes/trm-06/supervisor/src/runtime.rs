//! Linux process adapter. Activation requires installed-main authority outside
//! this disposable probe; branch entrypoints continue to refuse root execution.
use crate::cgroup::{Group, Sessions};
use crate::identity::{self, User};
use crate::live::Live;
use crate::registry::{Kind, Owner, Registry, Resources};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

pub struct Launch {
    pub owner: Owner,
    pub kind: Kind,
    pub argv: Vec<String>,
    pub size: (u16, u16),
    pub port: u16,
    pub term: String,
    pub modes: Vec<u8>,
}
pub struct Process {
    pub child: Child,
    pub input: Arc<Mutex<Option<File>>>,
    pub output: File,
    pub error: Option<File>,
}
struct OwnedSession {
    group: Arc<Group>,
    live: Option<Arc<Live>>,
}
pub struct Kernel {
    groups: Sessions,
    owned: BTreeMap<String, OwnedSession>,
}
fn refused() -> io::Error {
    io::Error::other("invalid session launch")
}
impl Kernel {
    pub fn open() -> io::Result<Registry<Self>> {
        Registry::start(Self {
            groups: Sessions::open()?,
            owned: BTreeMap::new(),
        })
    }
    /// argv is bounded before fork. No caller-selected environment, executable
    /// search path, uid, home, cwd, SFTP server or TCP destination is accepted.
    /// Payload-dependent cwd/exec/network operations occur after verified drop.
    pub fn spawn(&mut self, id: &str, launch: Launch) -> io::Result<Arc<Live>> {
        let Launch {
            owner: _,
            kind,
            ref argv,
            size,
            port,
            ref term,
            ref modes,
        } = launch;
        validate_open(kind, argv, size, port)?;
        if !crate::terminal::valid_term(term) {
            return Err(refused());
        }
        if kind != Kind::Pty && (!term.is_empty() || !modes.is_empty()) {
            return Err(refused());
        }
        if kind == Kind::Pty {
            crate::terminal::decode(modes)?;
        }
        let group = Arc::new(self.groups.create(id)?);
        self.owned.insert(
            id.to_owned(),
            OwnedSession {
                group: group.clone(),
                live: None,
            },
        );
        let result = self
            .spawn_in(group, &launch)
            .and_then(|process| Live::start(process, kind).map(Arc::new));
        match result {
            Ok(process) => {
                let entry = self.owned.get_mut(id).ok_or_else(refused)?;
                entry.live = Some(process.clone());
                Ok(process)
            }
            Err(error) => {
                // A failed exec may still have joined its cgroup. Never forget it
                // unless the independent cgroup drain succeeds.
                self.drain(&[id.to_owned()])?;
                Err(error)
            }
        }
    }
    fn spawn_in(&self, group: Arc<Group>, launch: &Launch) -> io::Result<Process> {
        let Launch {
            owner,
            kind,
            argv,
            size,
            port,
            term,
            modes,
        } = launch;
        let (owner, kind, size, port) = (*owner, *kind, *size, *port);
        let terminal_modes = if kind == Kind::Pty {
            crate::terminal::decode(modes)?
        } else {
            Vec::new()
        };
        let mut command = match kind {
            Kind::Exec | Kind::Pty => {
                let mut c = Command::new(&argv[0]);
                c.args(&argv[1..]);
                c
            }
            Kind::Sftp => Command::new("/usr/lib/openssh/sftp-server"),
            Kind::Tcp => {
                let mut c = Command::new("/opt/smithers/prototype/supervisor");
                c.args(["--tcp-worker", &port.to_string()]);
                c
            }
        };
        let (login, home, user) = match owner {
            Owner::Ben => ("ben", "/home/ben", User::Ben),
            Owner::Agent => ("agent", "/home/agent", User::Agent),
        };
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home)
            .env("USER", login)
            .env("LOGNAME", login)
            .env("SHELL", "/bin/sh")
            .env(
                "TERM",
                if term.is_empty() {
                    "xterm-256color"
                } else {
                    term
                },
            );
        let (mut master, mut control) = (None, None);
        if kind == Kind::Pty {
            let mut m = -1;
            let mut s = -1;
            let window = libc::winsize {
                ws_col: size.0,
                ws_row: size.1,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            if unsafe {
                libc::openpty(
                    &mut m,
                    &mut s,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    &window,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            let m = unsafe { File::from_raw_fd(m) };
            let s = unsafe { File::from_raw_fd(s) };
            // openpty does not set CLOEXEC. Every unrelated descriptor must be
            // closed by exec, including the parent's master and control copy.
            cloexec(&m)?;
            cloexec(&s)?;
            command
                .stdin(Stdio::from(s.try_clone()?))
                .stdout(Stdio::from(s.try_clone()?))
                .stderr(Stdio::from(s.try_clone()?));
            control = Some(s);
            master = Some(m);
        } else {
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        }
        let cwd = CString::new("/workspace").unwrap();
        let home_scope = CString::new(home).unwrap();
        let enrollment = group.enrollment_fd()?;
        // pre_exec only uses fixed data and async-signal-safe syscalls. The
        // held group is joined before any untrusted executable can run.
        unsafe {
            command.pre_exec(move || {
                if libc::write(enrollment.as_raw_fd(), b"0".as_ptr().cast(), 1) != 1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                identity::drop_child(user)?;
                crate::confinement::restrict(&home_scope)?;
                if kind == Kind::Pty && libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                if kind == Kind::Pty {
                    crate::terminal::apply(&terminal_modes)?;
                }
                if libc::chdir(cwd.as_ptr()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        drop(control);
        let (input, output, error) = match master {
            Some(master) => (Some(master.try_clone()?), master, None),
            None => (
                child.stdin.take().map(|v| File::from(OwnedFd::from(v))),
                File::from(OwnedFd::from(child.stdout.take().ok_or_else(refused)?)),
                child.stderr.take().map(|v| File::from(OwnedFd::from(v))),
            ),
        };
        Ok(Process {
            child,
            input: Arc::new(Mutex::new(input)),
            output,
            error,
        })
    }
}
impl Resources for Kernel {
    fn startup(&mut self) -> io::Result<()> {
        self.groups.startup_barrier()?;
        for entry in self.owned.values() {
            if let Some(live) = &entry.live {
                live.terminated()?;
            }
        }
        self.owned.clear();
        Ok(())
    }
    fn close(&mut self, id: &str, _kind: Kind) -> io::Result<()> {
        if let Some(live) = self.owned.get(id).and_then(|s| s.live.as_ref()) {
            live.close()?;
        }
        Ok(())
    }
    fn drain(&mut self, ids: &[String]) -> io::Result<()> {
        let groups: Vec<_> = ids
            .iter()
            .filter_map(|id| self.owned.get(id).map(|s| s.group.as_ref()))
            .collect();
        Group::kill_all(&groups)?;
        for id in ids {
            if self.owned.contains_key(id) {
                if let Some(live) = self.owned.get(id).and_then(|s| s.live.as_ref()) {
                    live.terminated()?;
                }
                self.groups.remove(id)?;
                self.owned.remove(id);
            }
        }
        Ok(())
    }
}
fn cloexec(file: &File) -> io::Result<()> {
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub fn signal_number(name: &str) -> io::Result<i32> {
    Ok(match name {
        "INT" => libc::SIGINT,
        "TERM" => libc::SIGTERM,
        "HUP" => libc::SIGHUP,
        "KILL" => libc::SIGKILL,
        "QUIT" => libc::SIGQUIT,
        "USR1" => libc::SIGUSR1,
        "USR2" => libc::SIGUSR2,
        _ => return Err(refused()),
    })
}
pub fn validate_open(kind: Kind, argv: &[String], size: (u16, u16), port: u16) -> io::Result<()> {
    if argv.len() > 128
        || argv.iter().map(String::len).sum::<usize>() > 32768
        || argv.iter().any(|v| v.contains('\0'))
    {
        return Err(refused());
    }
    match kind {
        Kind::Exec | Kind::Pty
            if argv
                .first()
                .is_none_or(|v| !v.starts_with('/') || v.len() > 4096) =>
        {
            return Err(refused());
        }
        Kind::Pty if size.0 == 0 || size.1 == 0 => return Err(refused()),
        Kind::Sftp | Kind::Tcp if !argv.is_empty() => return Err(refused()),
        Kind::Tcp if port == 0 => return Err(refused()),
        _ => {}
    }
    if kind != Kind::Tcp && port != 0 {
        return Err(refused());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payload_policy_rejects_before_cgroup_creation() {
        for (kind, argv, size, port) in [
            (Kind::Exec, vec![], (0, 0), 0),
            (Kind::Exec, vec!["sh".into()], (0, 0), 0),
            (Kind::Pty, vec!["/bin/sh".into()], (0, 40), 0),
            (Kind::Sftp, vec!["/tmp/member-server".into()], (0, 0), 0),
            (Kind::Tcp, vec![], (0, 0), 0),
            (Kind::Exec, vec!["/bin/sh\0".into()], (0, 0), 0),
        ] {
            assert!(validate_open(kind, &argv, size, port).is_err());
        }
        for (kind, argv, size, port) in [
            (
                Kind::Exec,
                vec!["/bin/sh".into(), "-c".into(), "exit 7".into()],
                (0, 0),
                0,
            ),
            (Kind::Pty, vec!["/bin/sh".into()], (120, 40), 0),
            (Kind::Sftp, vec![], (0, 0), 0),
            (Kind::Tcp, vec![], (0, 0), 65535),
        ] {
            validate_open(kind, &argv, size, port).unwrap();
        }
        assert!(validate_open(Kind::Exec, &vec!["/x".into(); 129], (0, 0), 0).is_err());
        assert!(
            validate_open(Kind::Exec, &[format!("/{}", "x".repeat(32768))], (0, 0), 0).is_err()
        );
    }
    #[test]
    fn unprivileged_runtime_refuses_before_any_process_or_cleanup() {
        assert_ne!(unsafe { libc::geteuid() }, 0);
        assert!(Kernel::open().is_err());
    }
}
