//! Linux process ownership. Only the fixed kernel/account paths are opened as
//! root. Session argv, cwd and environment are used after the permanent uid drop.
use super::{
    cgroups::Cgroups,
    sessions::{Kind, User},
    supervisor::Kernel,
};
use crate::session_stream::Exit;
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            process::{CommandExt, ExitStatusExt},
        },
    },
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// T-MCH-12/T-TRM-02 supply current session environment/credential bindings.
/// This is deliberately required, not a flag inferred from account existence.
pub trait Admission: Send {
    fn available(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn environment(&mut self, user: &User) -> io::Result<Vec<(String, String)>>;
}
pub struct Unavailable;
impl Admission for Unavailable {
    fn environment(&mut self, _: &User) -> io::Result<Vec<(String, String)>> {
        Err(io::ErrorKind::Unsupported.into())
    }
}
fn invalid() -> io::Error {
    io::ErrorKind::PermissionDenied.into()
}
fn fixed_file(path: &str) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let m = file.metadata()?;
    if !m.is_file() || m.uid() != 0 || m.mode() & 0o022 != 0 || m.nlink() != 1 {
        return Err(invalid());
    }
    Ok(file)
}
fn account(user: &User) -> io::Result<()> {
    user.validate()?;
    // No NSS module or branch import executes in the privileged broker.
    let etc = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open("/etc")?;
    let stat = etc.metadata()?;
    if stat.uid() != 0 || stat.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    let mut passwd = String::new();
    fixed_file("/etc/passwd")?
        .take(1024 * 1024 + 1)
        .read_to_string(&mut passwd)?;
    if passwd.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let mut matching = 0;
    for line in passwd.lines() {
        let f: Vec<_> = line.split(':').collect();
        if f.len() != 7 {
            return Err(invalid());
        }
        if f[0] == user.login || f[2] == user.uid.to_string() {
            if f[0] != user.login
                || f[2] != user.uid.to_string()
                || f[3] != user.uid.to_string()
                || f[5] != format!("/home/{}", user.login)
                || f[6] != "/bin/bash"
            {
                return Err(invalid());
            }
            matching += 1;
        }
    }
    if matching != 1 {
        return Err(invalid());
    }
    let mut groups = String::new();
    fixed_file("/etc/group")?
        .take(1024 * 1024 + 1)
        .read_to_string(&mut groups)?;
    if groups.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let mut team = 0;
    for line in groups.lines() {
        let f: Vec<_> = line.split(':').collect();
        if f.len() != 4 {
            return Err(invalid());
        }
        let member = f[3].split(',').any(|login| login == user.login);
        if f[0] == "team" || f[2] == "20000" {
            if f[0] != "team" || f[2] != "20000" || !member {
                return Err(invalid());
            }
            team += 1;
        } else if member {
            return Err(invalid());
        }
    }
    if team != 1 {
        return Err(invalid());
    }
    Ok(())
}
fn nonblocking(file: &impl AsRawFd) -> io::Result<()> {
    // SAFETY: fcntl acts on a live broker-owned descriptor.
    unsafe {
        let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
        if flags < 0 || libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
fn signal_number(signal: u8) -> io::Result<i32> {
    match signal {
        1 => Ok(libc::SIGINT),
        2 => Ok(libc::SIGTERM),
        3 => Ok(libc::SIGHUP),
        4 => Ok(libc::SIGKILL),
        5 => Ok(libc::SIGQUIT),
        6 => Ok(libc::SIGUSR1),
        7 => Ok(libc::SIGUSR2),
        _ => Err(invalid()),
    }
}
struct Process {
    child: Child,
    kind: Kind,
    master: Option<File>,
    input: Option<std::process::ChildStdin>,
    output: Option<std::process::ChildStdout>,
    error: Option<std::process::ChildStderr>,
    exit_observed: bool,
}
pub struct Processes<A> {
    groups: Cgroups,
    admission: A,
    processes: BTreeMap<u32, Process>,
    prepared: Option<(User, Vec<(String, String)>)>,
}
impl<A: Admission> Processes<A> {
    pub fn new(groups: Cgroups, admission: A) -> Self {
        Self {
            groups,
            admission,
            processes: BTreeMap::new(),
            prepared: None,
        }
    }
    fn process(&mut self, id: u32) -> io::Result<&mut Process> {
        self.processes.get_mut(&id).ok_or_else(invalid)
    }
}
impl<A: Admission> Kernel for Processes<A> {
    fn available(&mut self) -> io::Result<()> {
        self.admission.available()
    }
    fn recover(&mut self, deadline: Instant) -> io::Result<()> {
        self.groups.recover(deadline)
    }
    fn ready(&mut self, user: &User) -> io::Result<()> {
        self.prepared = None;
        if unsafe { libc::geteuid() } != 0 {
            return Err(invalid());
        }
        account(user)?;
        let environment = self.admission.environment(user)?;
        if environment
            .iter()
            .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
        {
            return Err(invalid());
        }
        self.prepared = Some((user.clone(), environment));
        Ok(())
    }
    fn spawn(
        &mut self,
        id: u32,
        user: &User,
        kind: Kind,
        argv: &[String],
        size: Option<(u16, u16)>,
        port: Option<u16>,
    ) -> io::Result<()> {
        let (authorized, environment) = self.prepared.take().ok_or_else(invalid)?;
        if &authorized != user || self.processes.contains_key(&id) {
            return Err(invalid());
        }
        // TCP is an unprivileged image relay child, so it shares cgroup cleanup
        // and identity rules with every other session.
        let args = match kind {
            Kind::Sftp => vec!["/usr/lib/openssh/sftp-server".to_owned()],
            Kind::Tcp => vec![
                "/opt/smithers/bin/smithers-machined".to_owned(),
                "session-tcp".to_owned(),
                port.filter(|p| *p != 0).ok_or_else(invalid)?.to_string(),
            ],
            _ if argv.is_empty() => vec!["/bin/bash".to_owned(), "-l".to_owned()],
            _ => argv.to_vec(),
        };
        let mut procs = self.groups.create(id)?;
        let result = (|| {
            let mut command = Command::new(&args[0]);
            command
                .args(&args[1..])
                .env_clear()
                .envs(environment)
                .env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .env("HOME", format!("/home/{}", user.login))
                .env("USER", &user.login)
                .env("LOGNAME", &user.login);
            let mut master = None;
            if kind == Kind::Pty {
                let fd = rustix::pty::openpt(
                    rustix::pty::OpenptFlags::RDWR
                        | rustix::pty::OpenptFlags::NOCTTY
                        | rustix::pty::OpenptFlags::CLOEXEC,
                )?;
                rustix::pty::grantpt(&fd)?;
                rustix::pty::unlockpt(&fd)?;
                // TIOCGPTPEER resolves the slave from the held master, not /dev paths.
                let slave = unsafe {
                    libc::ioctl(
                        fd.as_raw_fd(),
                        libc::TIOCGPTPEER,
                        libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
                    )
                };
                if slave < 0 {
                    return Err(io::Error::last_os_error());
                }
                use std::os::fd::FromRawFd;
                let slave = unsafe { File::from_raw_fd(slave) };
                if unsafe { libc::fchown(slave.as_raw_fd(), user.uid, 20000) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                let (rows, cols) = size.unwrap_or((24, 80));
                let winsize = libc::winsize {
                    ws_row: rows,
                    ws_col: cols,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                if rows == 0
                    || cols == 0
                    || unsafe { libc::ioctl(fd.as_raw_fd(), libc::TIOCSWINSZ, &winsize) } < 0
                {
                    return Err(invalid());
                }
                command
                    .stdin(Stdio::from(slave.try_clone()?))
                    .stdout(Stdio::from(slave.try_clone()?))
                    .stderr(Stdio::from(slave));
                let file = File::from(fd);
                nonblocking(&file)?;
                master = Some(file);
            } else {
                command
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
            }
            let uid = user.uid;
            // SAFETY: only syscalls and writes to a held cgroup descriptor before
            // permanent privilege drop. Branch cwd/argv lookup follows the drop.
            unsafe {
                command.pre_exec(move || {
                    let mut digits = [0u8; 20];
                    let mut n = libc::getpid() as u32;
                    let mut i = digits.len();
                    loop {
                        i -= 1;
                        digits[i] = b'0' + (n % 10) as u8;
                        n /= 10;
                        if n == 0 {
                            break;
                        }
                    }
                    procs.write_all(&digits[i..])?;
                    if libc::setsid() < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if kind == Kind::Pty && libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let groups = [20000u32];
                    if libc::setgroups(1, groups.as_ptr()) != 0
                        || libc::setresgid(uid, uid, uid) != 0
                        || libc::setresuid(uid, uid, uid) != 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    libc::umask(0o002);
                    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                        || libc::chdir(c"/workspace".as_ptr()) != 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn()?;
            let input = child.stdin.take();
            let output = child.stdout.take();
            let error = child.stderr.take();
            if let Some(fd) = &input {
                nonblocking(fd)?;
            }
            if let Some(fd) = &output {
                nonblocking(fd)?;
            }
            if let Some(fd) = &error {
                nonblocking(fd)?;
            }
            self.processes.insert(
                id,
                Process {
                    child,
                    kind,
                    master,
                    input,
                    output,
                    error,
                    exit_observed: false,
                },
            );
            Ok(())
        })();
        if result.is_err() {
            self.groups
                .kill(id, Instant::now() + Duration::from_secs(5))?;
        }
        result
    }
    fn read(&mut self, id: u32, fd: u8, bytes: &mut [u8]) -> io::Result<usize> {
        let p = self.process(id)?;
        if let Some(master) = &mut p.master {
            return match master.read(bytes) {
                Err(e) if e.raw_os_error() == Some(libc::EIO) => Ok(0),
                result => result,
            };
        }
        match fd {
            1 => p.output.as_mut().ok_or_else(invalid)?.read(bytes),
            2 => p.error.as_mut().ok_or_else(invalid)?.read(bytes),
            _ => Err(invalid()),
        }
    }
    fn write(&mut self, id: u32, bytes: &[u8]) -> io::Result<usize> {
        let p = self.process(id)?;
        if let Some(master) = &mut p.master {
            master.write(bytes)
        } else {
            p.input
                .as_mut()
                .ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?
                .write(bytes)
        }
    }
    fn eof(&mut self, id: u32) -> io::Result<()> {
        let p = self.process(id)?;
        if let Some(master) = &mut p.master {
            master.write_all(&[4])?;
        } else {
            p.input.take();
        }
        Ok(())
    }
    fn resize(&mut self, id: u32, rows: u16, cols: u16) -> io::Result<()> {
        let p = self.process(id)?;
        let master = p.master.as_ref().ok_or_else(invalid)?;
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        if rows == 0 || cols == 0 {
            return Err(invalid());
        }
        if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    fn signal(&mut self, id: u32, signal: u8) -> io::Result<()> {
        let signal = signal_number(signal)?;
        let p = self.process(id)?;
        if !matches!(p.kind, Kind::Exec | Kind::Pty) || p.exit_observed {
            return Err(invalid());
        }
        if unsafe { libc::kill(-(p.child.id() as i32), signal) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    fn exited(&mut self, id: u32) -> io::Result<Option<Exit>> {
        let p = self.process(id)?;
        if p.exit_observed {
            return Ok(None);
        }
        let Some(status) = p.child.try_wait()? else {
            return Ok(None);
        };
        p.exit_observed = true;
        Ok(Some(if let Some(code) = status.code() {
            Exit::Code(code)
        } else {
            let actual = status.signal().ok_or_else(invalid)?;
            match (1..=7).find(|s| signal_number(*s).ok() == Some(actual)) {
                Some(signal) => Exit::Signal {
                    signal,
                    core: status.core_dumped(),
                },
                None => Exit::Code(128 + actual),
            }
        }))
    }
    fn close(&mut self, id: u32, kind: Kind) -> io::Result<()> {
        let p = self.process(id)?;
        if kind == Kind::Pty {
            // HUP the process group explicitly: duplicated masters must never
            // accidentally keep a closed PTY's foreground process alive.
            if !p.exit_observed
                && unsafe { libc::kill(-(p.child.id() as i32), libc::SIGHUP) } < 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
            {
                return Err(io::Error::last_os_error());
            }
            p.master.take();
        } else {
            p.input.take();
        }
        Ok(())
    }
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()> {
        self.groups.kill(id, deadline)?;
        if let Some(mut p) = self.processes.remove(&id) {
            p.child.wait()?;
        }
        Ok(())
    }
    fn freeze(&mut self, t: Duration) -> io::Result<Option<u32>> {
        super::control::Controls::freeze(&mut self.groups, t)
    }
    fn thaw(&mut self) -> io::Result<()> {
        super::control::Controls::thaw(&mut self.groups)
    }
}

/// Runs only as the already-dropped session user. Half-close on stdin EOF
/// preserves reads until the loopback peer closes its write side.
pub fn tcp(port: u16) -> io::Result<()> {
    if unsafe { libc::geteuid() } < 19999 || port == 0 {
        return Err(invalid());
    }
    let mut socket = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))?;
    let mut writer = socket.try_clone()?;
    let input = std::thread::spawn(move || -> io::Result<()> {
        io::copy(&mut io::stdin().lock(), &mut writer)?;
        writer.shutdown(std::net::Shutdown::Write)
    });
    io::copy(&mut socket, &mut io::stdout().lock())?;
    // Remote EOF ends the session even if stdin remains open; the process exit
    // closes the input pump. Waiting for it would deadlock an SSH half-close.
    drop(input);
    Ok(())
}
