//! TCP worker executed from the installed supervisor only after identity drop.
use std::io;
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::time::Duration;
fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "invalid TCP worker identity or target",
    )
}
pub fn tcp(port: u16) -> io::Result<()> {
    let uid = unsafe { libc::getuid() };
    if port == 0
        || !(uid == 20001 || uid == 19999)
        || unsafe { libc::geteuid() } != uid
        || unsafe { libc::getgid() } != uid
        || unsafe { libc::getegid() } != uid
    {
        return Err(refused());
    }
    let mut groups = [0; 2];
    let count = unsafe { libc::getgroups(2, groups.as_mut_ptr()) };
    if count != 1 || groups[0] != 20000 {
        return Err(refused());
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut output = TcpStream::connect_timeout(&address, Duration::from_secs(3))?;
    let mut input = output.try_clone()?;
    let writer = std::thread::spawn(move || {
        let result = io::copy(&mut io::stdin().lock(), &mut input);
        let _ = input.shutdown(Shutdown::Write);
        result
    });
    let result = io::copy(&mut output, &mut io::stdout().lock());
    let _ = output.shutdown(Shutdown::Both);
    // Remote EOF may arrive while stdin is still open. Process exit cancels
    // that blocked worker; waiting here would break TCP's output half-close.
    drop(writer);
    result.map(|_| ())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_rejects_root_and_other_users_before_network() {
        assert_ne!(unsafe { libc::getuid() }, 20001);
        assert_ne!(unsafe { libc::getuid() }, 19999);
        assert_eq!(tcp(1).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(tcp(0).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
}
