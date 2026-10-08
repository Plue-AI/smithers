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
    let (parent, child) = rustix::net::socketpair(
        rustix::net::AddressFamily::UNIX,
        rustix::net::SocketType::SEQPACKET,
        rustix::net::SocketFlags::CLOEXEC,
        None,
    )?;
    // Keep source descriptors above the installed daemon's fixed inherited FDs.
    let parent = rustix::io::fcntl_dupfd_cloexec(&parent, 10)?;
    let child = rustix::io::fcntl_dupfd_cloexec(&child, 10)?;
    let relay = TcpListener::bind("127.0.0.1:0")?;
    let port = relay.local_addr()?.port();
    let relay = rustix::io::fcntl_dupfd_cloexec(&relay, 10)?;
    let local = UnixListener::bind("/run/smithers/machined.sock")?;
    let local = rustix::io::fcntl_dupfd_cloexec(&local, 10)?;
    for (source, target) in [
        (child.as_raw_fd(), 3),
        (relay.as_raw_fd(), 4),
        (local.as_raw_fd(), 5),
    ] {
        if unsafe { libc::dup2(source, target) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    std::thread::spawn(move || {
        let _ = control::serve(&parent, &mut EmptyBroker(0));
    });
    println!("{port}");
    smithers_machined::installed::run()
}
#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("Linux rehearsal only")
}
