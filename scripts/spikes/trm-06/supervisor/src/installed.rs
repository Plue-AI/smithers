//! Fixed installed init/boot boundary. The host provider verifies signed review
//! receipts and bundle bytes before planting this executable and root-only boot.
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    process::Command,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::Duration,
};

pub const EXECUTABLE: &str = "/opt/smithers/prototype/supervisor";
const BOOT: &str = "/run/smithers/trm06/boot.json";
fn refused() -> io::Error {
    io::Error::other("prototype_authority_unavailable")
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Boot {
    pub revision: String,
    pub supervisor_sha256: String,
    pub boot: [u8; 16],
    pub secret: [u8; 32],
}
impl Boot {
    pub fn parse(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() > 4096 {
            return Err(refused());
        }
        let boot: Self = serde_json::from_slice(bytes).map_err(|_| refused())?;
        if boot.revision.len() != 40
            || boot.supervisor_sha256.len() != 64
            || !boot
                .revision
                .bytes()
                .chain(boot.supervisor_sha256.bytes())
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || boot.boot == [0; 16]
            || boot.secret == [0; 32]
        {
            return Err(refused());
        }
        Ok(boot)
    }
    pub fn installed() -> io::Result<Self> {
        if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
            return Err(refused());
        }
        let mut file = protected(BOOT, false)?;
        let mut bytes = Vec::new();
        (&mut file).take(4097).read_to_end(&mut bytes)?;
        let boot = Self::parse(&bytes)?;
        // Verify the actual running inode, not only the path's current bytes.
        if std::fs::read_link("/proc/self/exe")? != std::path::Path::new(EXECUTABLE) {
            return Err(refused());
        }
        let expected = protected(EXECUTABLE, true)?;
        let actual = File::open("/proc/self/exe")?;
        if expected.metadata()?.ino() != actual.metadata()?.ino()
            || expected.metadata()?.dev() != actual.metadata()?.dev()
        {
            return Err(refused());
        }
        let mut hash = Sha256::new();
        let mut actual = actual.take(64 * 1024 * 1024 + 1);
        let n = io::copy(&mut actual, &mut HashWriter(&mut hash))?;
        if n > 64 * 1024 * 1024 || format!("{:x}", hash.finalize()) != boot.supervisor_sha256 {
            return Err(refused());
        }
        Ok(boot)
    }
    pub fn authenticate(&self, stream: &mut TcpStream) -> io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| refused())?;
        stream.write_all(b"TRM06\x01")?;
        stream.write_all(&self.boot)?;
        stream.write_all(&nonce)?;
        let mut response = [0; 64];
        stream.read_exact(&mut response)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).map_err(|_| refused())?;
        mac.update(b"smithers-machined/v1 host");
        mac.update(&self.boot);
        mac.update(&nonce);
        mac.verify_slice(&response[32..]).map_err(|_| refused())?;
        let mut guest = Hmac::<Sha256>::new_from_slice(&self.secret).map_err(|_| refused())?;
        guest.update(b"smithers-trm06/v1 guest");
        guest.update(&self.boot);
        guest.update(&nonce);
        guest.update(&response[..32]);
        stream.write_all(&guest.finalize().into_bytes())?;
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        Ok(())
    }
}
struct HashWriter<'a>(&'a mut Sha256);
impl Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
// Held descriptors protect every ancestor; no branch/home/environment selects
// a destination. All files must be single-link root-owned exact-mode files.
fn protected(path: &str, executable: bool) -> io::Result<File> {
    let mut dir = File::open("/")?;
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        let leaf = i == parts.len() - 1;
        let name = std::ffi::CString::new(*part).map_err(|_| refused())?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | if leaf { 0 } else { libc::O_DIRECTORY },
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let m = file.metadata()?;
        if m.uid() != 0
            || m.mode() & 0o022 != 0
            || (leaf
                && (!m.is_file()
                    || m.nlink() != 1
                    || m.mode() & 0o7777 != if executable { 0o755 } else { 0o400 }))
        {
            return Err(refused());
        }
        dir = file;
    }
    Ok(dir)
}
pub fn serve() -> io::Result<()> {
    let boot = Boot::installed()?;
    // Supervisor::installed performs the complete startup drain before bind.
    let supervisor = Arc::new(Mutex::new(crate::control::Supervisor::installed()?));
    let listener = TcpListener::bind("127.0.0.1:970")?;
    crate::daemon::serve(
        listener,
        supervisor,
        move |s| boot.authenticate(s),
        Arc::new(AtomicBool::new(false)),
    )
}
pub fn init() -> io::Result<()> {
    Boot::installed()?;
    crate::accounts::provision_fresh()?;
    loop {
        // Each replacement re-verifies the installed inode and runs its own
        // cgroup barrier. No executable or env comes from the repository.
        Boot::installed()?;
        let status = Command::new(EXECUTABLE)
            .arg("--serve")
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .current_dir("/")
            .status()?;
        eprintln!("trm06 supervisor ended: {status}");
        std::thread::sleep(Duration::from_millis(100));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boot_is_bounded_and_identity_is_not_request_authority() {
        let good = serde_json::json!({"revision":"a".repeat(40),"supervisor_sha256":"b".repeat(64),"boot":vec![1;16],"secret":vec![2;32]});
        assert!(Boot::parse(good.to_string().as_bytes()).is_ok());
        for (key, value) in [
            ("uid", serde_json::json!(0)),
            ("revision", serde_json::json!("branch")),
            ("secret", serde_json::json!([0; 32].to_vec())),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert!(Boot::parse(bad.to_string().as_bytes()).is_err());
        }
        assert!(Boot::parse(&vec![b' '; 4097]).is_err());
        assert!(Boot::installed().is_err());
    }
    #[test]
    fn real_tcp_boot_proof_precedes_any_control_input() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for valid in [true, false] {
                let (mut stream, _) = listener.accept().unwrap();
                let boot = Boot {
                    revision: "a".repeat(40),
                    supervisor_sha256: "b".repeat(64),
                    boot: [1; 16],
                    secret: [2; 32],
                };
                assert_eq!(boot.authenticate(&mut stream).is_ok(), valid);
                if valid {
                    stream.write_all(b"dispatch").unwrap();
                }
            }
        });
        for valid in [true, false] {
            let mut peer = TcpStream::connect(address).unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut challenge = [0; 54];
            peer.read_exact(&mut challenge).unwrap();
            assert_eq!(&challenge[..6], b"TRM06\x01");
            assert_eq!(&challenge[6..22], &[1; 16]);
            let mut mac = Hmac::<Sha256>::new_from_slice(&[2; 32]).unwrap();
            mac.update(b"smithers-machined/v1 host");
            mac.update(&challenge[6..22]);
            mac.update(&challenge[22..]);
            let mut proof = mac.finalize().into_bytes();
            if !valid {
                proof[0] ^= 1;
            }
            peer.write_all(&[3; 32]).unwrap();
            peer.write_all(&proof).unwrap();
            if valid {
                let mut reply = [0; 32];
                peer.read_exact(&mut reply).unwrap();
                let mut guest = Hmac::<Sha256>::new_from_slice(&[2; 32]).unwrap();
                guest.update(b"smithers-trm06/v1 guest");
                guest.update(&challenge[6..22]);
                guest.update(&challenge[22..]);
                guest.update(&[3; 32]);
                guest.verify_slice(&reply).unwrap();
                let mut dispatch = [0; 8];
                peer.read_exact(&mut dispatch).unwrap();
                assert_eq!(&dispatch, b"dispatch");
            } else {
                assert_eq!(peer.read(&mut [0]).unwrap(), 0);
            }
        }
        server.join().unwrap();
    }
}
