//! Trusted-process fixture: the installed daemon and all filesystem providers
//! run unchanged. There are no broker-owned sessions; session opening refuses.
//! Launch only in an unprivileged user/mount namespace with UID 19998.
#[cfg(target_os = "linux")]
fn main() -> std::io::Result<()> {
    use smithers_machined::broker::{
        control::{self, Controls},
        request::Request,
    };
    use std::{
        io,
        net::TcpListener,
        os::{fd::AsRawFd, unix::net::UnixListener},
        time::Duration,
    };
    struct EmptyBroker(u32);
    impl Controls for EmptyBroker {
        fn stream(&mut self, op: u8, _: &[u8]) -> io::Result<Vec<u8>> {
            match op {
                18 | 21 | 22 | 23 => Ok(vec![]),
                24 => {
                    self.0 = self.0.checked_add(1).ok_or(io::ErrorKind::Other)?;
                    Ok(self.0.to_be_bytes().to_vec())
                }
                25 => Ok(b"[]".to_vec()),
                _ => Err(io::ErrorKind::Unsupported.into()),
            }
        }
        fn session(&mut self, request: Request) -> io::Result<Vec<u8>> {
            match request {
                Request::Roster(_) => Ok(vec![0, 0, 0, 0]),
                _ => Err(io::ErrorKind::Unsupported.into()),
            }
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            Ok(None)
        }
        fn thaw(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn kill(&mut self) -> io::Result<u16> {
            Ok(0)
        }
    }
    if rustix::process::getuid().as_raw() != 19998 || rustix::process::geteuid().as_raw() != 19998 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let sockets = rustix::net::socketpair(
        rustix::net::AddressFamily::UNIX,
        rustix::net::SocketType::SEQPACKET,
        rustix::net::SocketFlags::CLOEXEC,
        None,
    )?;
    // Keep source descriptors above the installed daemon's fixed inherited FDs.
    let parent = rustix::io::fcntl_dupfd_cloexec(&sockets.0, 10)?;
    let child = rustix::io::fcntl_dupfd_cloexec(&sockets.1, 10)?;
    drop(sockets);
    let relay_listener = TcpListener::bind("127.0.0.1:0")?;
    let port = relay_listener.local_addr()?.port();
    let relay = rustix::io::fcntl_dupfd_cloexec(&relay_listener, 10)?;
    drop(relay_listener);
    let local_listener = UnixListener::bind("/run/smithers/machined.sock")?;
    let local = rustix::io::fcntl_dupfd_cloexec(&local_listener, 10)?;
    drop(local_listener);
    for (source, target) in [
        (child.as_raw_fd(), 3),
        (relay.as_raw_fd(), 4),
        (local.as_raw_fd(), 5),
    ] {
        if unsafe { libc::dup2(source, target) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let installed = std::env::args().nth(1).as_deref() == Some("--installed");
    if !installed {
        std::thread::spawn(move || {
            let _ = control::serve(&parent, &mut EmptyBroker(0));
        });
    }
    println!("{port}");
    // Optional boundary mode launches the packaged binary rather than calling its
    // entrypoint in this fixture process. The namespace supplies this fixed
    // path; never use this fixture as a privileged guest broker.
    if installed {
        use smithers_machined::broker::lifecycle::{self, Process};
        struct NamespaceInit {
            fault: Option<String>,
        }
        impl Process for NamespaceInit {
            fn kill_sessions(&mut self) -> io::Result<()> {
                // This fixture never admits sessions. Real descendant cleanup
                // is qualified by the protected guest broker, not this census.
                Ok(())
            }
            fn run_daemon(&mut self) -> io::Result<(i32, Duration)> {
                let start = std::time::Instant::now();
                use std::os::unix::process::CommandExt;
                let (server, client) = rustix::net::socketpair(
                    rustix::net::AddressFamily::UNIX,
                    rustix::net::SocketType::SEQPACKET,
                    rustix::net::SocketFlags::CLOEXEC,
                    None,
                )?;
                let high = rustix::io::fcntl_dupfd_cloexec(&client, 10)?;
                drop(client);
                let client = high;
                let descriptor = client.as_raw_fd();
                let supervisor = unsafe { libc::getpid() };
                let broker =
                    std::thread::spawn(move || control::serve(&server, &mut EmptyBroker(0)));

                let mut command = std::process::Command::new("/opt/smithers/bin/smithers-machined");
                command
                    .arg("daemon")
                    .env_clear()
                    .env("PATH", "/usr/bin:/bin");
                if let Some(fault) = self.fault.take() {
                    command.env("SMITHERS_MACHINED_KILL_AT", fault);
                }
                // Only process-lifetime and dup2 syscalls run in the forked child.
                // Each lifetime has its own production socketpair, so an old
                // reply cannot poison startup.
                unsafe {
                    command.pre_exec(move || {
                        // bwrap owns init; init owns this daemon. Preserve
                        // that lifetime even when an assertion kills bwrap,
                        // rather than leaving an orphan with deleted state.
                        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                            || libc::getppid() != supervisor
                        {
                            return Err(io::ErrorKind::Interrupted.into());
                        }
                        if libc::dup2(descriptor, 3) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
                let mut child = command.spawn()?;
                drop(client);
                std::fs::write("/run/smithers/namespace-daemon.pid", child.id().to_string())?;
                if !std::path::Path::new("/run/smithers/namespace-first.pid").exists() {
                    std::fs::write("/run/smithers/namespace-first.pid", child.id().to_string())?;
                }
                let status = child.wait()?;
                let _ = broker.join();
                if !std::path::Path::new("/run/smithers/namespace-first.status").exists() {
                    std::fs::write(
                        "/run/smithers/namespace-first.status",
                        status.code().unwrap_or(1).to_string(),
                    )?;
                }
                Ok((status.code().unwrap_or(1), start.elapsed()))
            }
            fn delay(&mut self, duration: Duration) {
                std::thread::sleep(duration);
            }
        }
        return lifecycle::supervise(&mut NamespaceInit {
            fault: std::env::args().nth(2),
        });
    }
    smithers_machined::installed::run()
}
#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("Linux rehearsal only")
}
